// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ATSStorageMarket} from "./ATSStorageMarket.sol";

/// @notice Fully prefunded publisher tasks. Human/committee acceptance is explicitly trusted.
contract ATSPublisherTasks is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    ATSStorageMarket public immutable committee;
    uint64 public immutable reviewDelay;
    enum State { None, Open, Review, Paid, Refunded }
    struct Task { address sponsor; bytes32 specification; uint256 amount; uint64 deadline; State state; bytes32 publicationId; bytes32 evidenceHash; uint64 readyAt; uint64 generation; uint32 round; bool challenged; }
    mapping(uint256 => Task) public tasks;
    /// @notice Set once at funding; zero identifies a compatibility/plain acceptance task.
    mapping(uint256 => uint64) public minimumServiceSeconds;
    mapping(uint256 => uint64) public openedAt;
    mapping(uint256 => uint256) public retentionOrder;
    event RetainedTaskOpened(uint256 indexed taskId, uint64 minimumSeconds);
    event RetentionOrderAccepted(uint256 indexed taskId, uint256 indexed orderId);
    mapping(bytes32 => uint8) public approvals;
    mapping(bytes32 => mapping(address => bool)) public votes;
    uint256 public nextTask = 1;
    uint256 public escrow;
    event TaskOpened(uint256 indexed taskId, address indexed sponsor, bytes32 specification, uint256 amount, uint64 deadline);
    event CandidateVoted(uint256 indexed taskId, bytes32 indexed candidate, address indexed observer, uint8 approvals);
    event TaskApproved(uint256 indexed taskId, bytes32 indexed publicationId, bytes32 evidenceHash, uint64 readyAt);
    event TaskChallenged(uint256 indexed taskId, bytes32 reasonHash);
    event TaskResolved(uint256 indexed taskId, bool accepted, bytes32 resolutionHash);
    event TaskPaid(uint256 indexed taskId, bytes32 indexed publicationId, uint256 amount);
    event TaskRefunded(uint256 indexed taskId, uint256 amount);
    constructor(ATSStorageMarket serviceMarket) {
        require(address(serviceMarket) != address(0), "committee"); committee = serviceMarket;
        token = serviceMarket.token(); reviewDelay = serviceMarket.reviewDelay();
    }
    function openTask(bytes32 specification, uint256 amount, uint64 deadline) external nonReentrant returns (uint256 id) {
        return _openTask(specification, amount, deadline, 0);
    }
    function openRetainedTask(bytes32 specification, uint256 amount, uint64 deadline, uint64 minimumSeconds) external nonReentrant returns (uint256 id) {
        require(minimumSeconds > 0 && minimumSeconds <= 366 days, "service requirement");
        return _openTask(specification, amount, deadline, minimumSeconds);
    }
    function _openTask(bytes32 specification, uint256 amount, uint64 deadline, uint64 minimumSeconds) private returns (uint256 id) {
        require(specification != 0 && amount > 0 && deadline > block.timestamp && deadline <= block.timestamp + 366 days, "task");
        id = nextTask++;
        tasks[id] = Task(msg.sender, specification, amount, deadline, State.Open, 0, 0, 0, committee.committeeGeneration(), 0, false);
        minimumServiceSeconds[id] = minimumSeconds;
        openedAt[id] = uint64(block.timestamp);
        if (minimumSeconds > 0) emit RetainedTaskOpened(id, minimumSeconds);
        escrow += amount; uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount); require(token.balanceOf(address(this)) == beforeBalance + amount, "unsupported token");
        emit TaskOpened(id, msg.sender, specification, amount, deadline);
    }
    function candidateHash(uint256 id, bytes32 publicationId, bytes32 evidenceHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), id, committee.committeeGeneration(), tasks[id].round, publicationId, evidenceHash));
    }
    function retainedCandidateHash(uint256 id, bytes32 publicationId, bytes32 evidenceHash, uint256 orderId) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), "retained-task-v1", id, committee.committeeGeneration(), tasks[id].round, publicationId, evidenceHash, orderId, minimumServiceSeconds[id]));
    }
    function attestTask(uint256 id, bytes32 publicationId, bytes32 evidenceHash) external {
        require(minimumServiceSeconds[id] == 0, "retained task requires order");
        _attest(id, publicationId, evidenceHash, 0);
    }
    function attestRetainedTask(uint256 id, bytes32 publicationId, bytes32 evidenceHash, uint256 orderId) external {
        require(minimumServiceSeconds[id] > 0 && orderId > 0, "not retained task");
        (bytes32 retainedPublication,) = committee.orderService(orderId);
        require(retainedPublication == publicationId, "retention publication");
        (uint64 serviceStart,) = committee.serviceWindow(orderId);
        require(serviceStart >= openedAt[id], "service predates task");
        _attest(id, publicationId, evidenceHash, orderId);
    }
    function _attest(uint256 id, bytes32 publicationId, bytes32 evidenceHash, uint256 orderId) private {
        require(committee.observers(msg.sender), "observer"); Task storage task = tasks[id];
        require(task.state == State.Open && block.timestamp < task.deadline && evidenceHash != 0, "not open");
        (address publisher,,,,,) = committee.registry().publications(publicationId); require(publisher != address(0), "publication");
        bytes32 candidate = orderId == 0 ? candidateHash(id, publicationId, evidenceHash) : retainedCandidateHash(id, publicationId, evidenceHash, orderId);
        require(!votes[candidate][msg.sender], "vote replay"); votes[candidate][msg.sender] = true;
        uint8 count = ++approvals[candidate]; emit CandidateVoted(id, candidate, msg.sender, count);
        if (count == committee.threshold()) {
            task.state = State.Review; task.publicationId = publicationId; task.evidenceHash = evidenceHash;
            retentionOrder[id] = orderId;
            if (orderId > 0) emit RetentionOrderAccepted(id, orderId);
            task.generation = committee.committeeGeneration(); task.readyAt = uint64(block.timestamp) + reviewDelay;
            emit TaskApproved(id, publicationId, evidenceHash, task.readyAt);
        }
    }
    function challengeTask(uint256 id, bytes32 reasonHash) external {
        Task storage task = tasks[id];
        require((msg.sender == task.sponsor || msg.sender == committee.owner()) && task.state == State.Review && block.timestamp < task.readyAt && !task.challenged && reasonHash != 0, "challenge");
        task.challenged = true; emit TaskChallenged(id, reasonHash);
    }
    function resolveTask(uint256 id, bool accepted, bytes32 resolutionHash) external {
        require(msg.sender == committee.owner(), "administrator"); Task storage task = tasks[id];
        require(task.challenged && resolutionHash != 0, "not challenged");
        if (accepted) { task.challenged = false; task.readyAt = uint64(block.timestamp) + reviewDelay; }
        else { delete retentionOrder[id]; task.state = State.Open; task.challenged = false; task.publicationId = 0; task.evidenceHash = 0; task.readyAt = 0; ++task.round; }
        emit TaskResolved(id, accepted, resolutionHash);
    }
    /// @notice Committee rotation must obtain fresh votes, rather than permanently trapping review.
    function reopenAfterRotation(uint256 id) external {
        Task storage task = tasks[id]; require(task.state == State.Review && task.generation != committee.committeeGeneration(), "same committee");
        delete retentionOrder[id]; task.state = State.Open; task.challenged = false; task.publicationId = 0; task.evidenceHash = 0; task.readyAt = 0; ++task.round;
    }
    function claimTask(uint256 id) external nonReentrant {
        Task storage task = tasks[id];
        require(task.state == State.Review && !task.challenged && task.generation == committee.committeeGeneration() && block.timestamp >= task.readyAt, "not ready");
        if (minimumServiceSeconds[id] > 0) {
            (bytes32 retainedPublication, uint64 serviceSeconds) = committee.orderService(retentionOrder[id]);
            require(retainedPublication == task.publicationId && serviceSeconds >= minimumServiceSeconds[id], "retention not earned");
        }
        task.state = State.Paid; escrow -= task.amount;
        (address[] memory recipients, uint16[] memory bps) = committee.registry().royaltySplit(task.publicationId);
        uint256 paid;
        for (uint256 i; i < recipients.length; ++i) {
            uint256 part = i + 1 == recipients.length ? task.amount - paid : Math.mulDiv(task.amount, bps[i], 10000);
            paid += part; token.safeTransfer(recipients[i], part);
        }
        emit TaskPaid(id, task.publicationId, task.amount);
    }
    function refundTask(uint256 id) external nonReentrant {
        Task storage task = tasks[id];
        bool expired = (task.state == State.Open || task.state == State.Review) && block.timestamp > task.deadline + reviewDelay * 2;
        bool veto = task.state == State.Review && task.challenged && msg.sender == committee.owner();
        require(expired || veto, "not refundable");
        task.state = State.Refunded; escrow -= task.amount; token.safeTransfer(task.sponsor, task.amount);
        emit TaskRefunded(id, task.amount);
    }
}
