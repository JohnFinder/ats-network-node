// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Testnet accounting prototype: fixed-budget services, bounties and rewards.
/// @dev Attestors and owner are trusted bootstrap roles. Hashes are evidence references,
/// not proofs of independent replication, copyright ownership or honest downloads.
contract ATSServiceMarket is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    uint256 public immutable minimumBond;
    uint64 public immutable reviewDelay;
    uint64 public immutable unbondDelay;
    uint8 public immutable approvalThreshold;
    mapping(address => bool) public attestors;
    uint256 public attestorCount;
    uint64 public committeeGeneration = 1;
    // Every token held is assigned to exactly one liability category.
    uint256 public totalBond;
    uint256 public serviceEscrow;
    uint256 public bountyEscrow;
    uint256 public rewardEscrow;

    struct Publication { address publisher; bytes32 archiveHash; bytes32 metadataHash; bytes32 previous; }
    mapping(bytes32 => Publication) public publications;
    mapping(address => uint256) public bond;
    mapping(address => uint256) public lockedBond;
    mapping(address => uint64) public unbondAt;
    enum State { None, Open, Accepted, Paid, Refunded }
    struct Service {
        address requester; address provider; bytes32 resourceId; uint256 amount;
        uint64 deadline; State state; bytes32 evidenceHash; uint8 approvals; uint64 voteGeneration;
    }
    mapping(uint256 => Service) public services;
    mapping(uint256 => mapping(address => uint64)) public serviceVotes;
    uint256 public nextService = 1;
    struct Bounty {
        address sponsor; uint256 amount; bytes32 specification; uint64 deadline;
        address recipient; bytes32 resourceId; bytes32 evidenceHash;
        uint64 readyAt; uint8 approvals; State state; uint64 voteGeneration;
    }
    mapping(uint256 => Bounty) public bounties;
    mapping(uint256 => mapping(address => uint64)) public bountyVotes;
    uint256 public nextBounty = 1;
    struct Epoch {
        address funder; bytes32 root; uint256 remaining;
        uint64 readyAt; uint64 expiresAt; bool closed;
    }
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(uint256 => bool)) public claimed;
    uint256 public nextEpoch = 1;

    event AttestorChanged(address indexed attestor, bool enabled);
    event Published(bytes32 indexed publicationId, address indexed publisher, bytes32 archiveHash, bytes32 metadataHash, bytes32 previous);
    event Bonded(address indexed provider, uint256 amount);
    event UnbondRequested(address indexed provider, uint64 readyAt);
    event Unbonded(address indexed provider, uint256 amount);
    event ServiceOpened(uint256 indexed jobId, address indexed requester, address indexed provider, bytes32 resourceId, uint256 amount, uint64 deadline);
    event ServiceAccepted(uint256 indexed jobId);
    event ServiceSettled(uint256 indexed jobId, bytes32 evidenceHash);
    event ServiceRefunded(uint256 indexed jobId);
    event BountyOpened(uint256 indexed bountyId, address indexed sponsor, uint256 amount, bytes32 specification);
    event BountyApproved(uint256 indexed bountyId, address recipient, bytes32 resourceId, bytes32 evidenceHash, uint64 readyAt);
    event BountyPaid(uint256 indexed bountyId, address indexed recipient, uint256 amount);
    event BountyRefunded(uint256 indexed bountyId);
    event RewardEpochProposed(uint256 indexed epochId, bytes32 root, uint256 budget, uint64 readyAt, uint64 expiresAt);
    event RewardClaimed(uint256 indexed epochId, uint256 indexed index, address indexed recipient, uint256 amount, bytes32 evidenceHash);
    event RewardEpochClosed(uint256 indexed epochId, uint256 refund);

    modifier onlyAttestor() { require(attestors[msg.sender], "not attestor"); _; }

    constructor(IERC20 asset, address administrator, address[] memory initialAttestors,
        uint8 threshold, uint256 bondPerService, uint64 reviewSeconds, uint64 unbondSeconds)
        Ownable(administrator)
    {
        require(address(asset) != address(0) && bondPerService > 0, "invalid asset/bond");
        require(reviewSeconds >= 60 && unbondSeconds >= 60, "delay too short");
        require(threshold >= 2 && threshold <= initialAttestors.length, "threshold");
        token = asset; minimumBond = bondPerService; reviewDelay = reviewSeconds;
        unbondDelay = unbondSeconds; approvalThreshold = threshold;
        for (uint256 i; i < initialAttestors.length; ++i) {
            address account = initialAttestors[i];
            require(account != address(0) && !attestors[account], "invalid attestor");
            attestors[account] = true;
            emit AttestorChanged(account, true);
        }
        attestorCount = initialAttestors.length;
    }

    function setAttestor(address account, bool enabled) external onlyOwner {
        require(account != address(0) && attestors[account] != enabled, "invalid change");
        if (enabled) ++attestorCount;
        else { require(attestorCount > approvalThreshold, "below threshold"); --attestorCount; }
        attestors[account] = enabled;
        ++committeeGeneration;
        emit AttestorChanged(account, enabled);
    }

    /// @notice Publisher-scoped identity prevents third parties claiming another wallet's version ID.
    function publicationID(address publisher, bytes32 archiveHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), publisher, archiveHash));
    }

    /// @dev EVM publisher and archive Ed25519 signer remain separate identities.
    function publish(bytes32 archiveHash, bytes32 metadataHash, bytes32 previous) external returns (bytes32 id) {
        require(archiveHash != bytes32(0) && metadataHash != bytes32(0), "empty publication");
        id = publicationID(msg.sender, archiveHash);
        require(publications[id].publisher == address(0), "already published");
        if (previous != bytes32(0)) require(publications[previous].publisher == msg.sender, "not previous publisher");
        publications[id] = Publication(msg.sender, archiveHash, metadataHash, previous);
        emit Published(id, msg.sender, archiveHash, metadataHash, previous);
    }

    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "zero amount");
        bond[msg.sender] += amount; totalBond += amount; unbondAt[msg.sender] = 0;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Bonded(msg.sender, amount);
    }

    function requestUnbond() external {
        require(bond[msg.sender] > 0 && lockedBond[msg.sender] == 0, "bond locked");
        unbondAt[msg.sender] = uint64(block.timestamp) + unbondDelay;
        emit UnbondRequested(msg.sender, unbondAt[msg.sender]);
    }

    function withdrawBond() external nonReentrant {
        uint64 ready = unbondAt[msg.sender];
        require(ready != 0 && block.timestamp >= ready && lockedBond[msg.sender] == 0, "not ready");
        uint256 amount = bond[msg.sender];
        require(amount > 0, "zero bond");
        bond[msg.sender] = 0; totalBond -= amount; unbondAt[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Unbonded(msg.sender, amount);
    }

    function openService(address provider, bytes32 resourceId, uint256 amount, uint64 deadline)
        external nonReentrant returns (uint256 id)
    {
        require(provider != address(0) && provider != msg.sender && amount > 0, "invalid service");
        require(publications[resourceId].publisher != address(0), "unknown publication");
        require(deadline > block.timestamp && deadline <= block.timestamp + 365 days, "deadline");
        id = nextService++;
        services[id] = Service(msg.sender, provider, resourceId, amount, deadline, State.Open, 0, 0, committeeGeneration);
        serviceEscrow += amount;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ServiceOpened(id, msg.sender, provider, resourceId, amount, deadline);
    }

    function acceptService(uint256 id) external {
        Service storage service = services[id];
        require(service.state == State.Open && service.provider == msg.sender, "not open/provider");
        require(block.timestamp < service.deadline && unbondAt[msg.sender] == 0, "expired/unbonding");
        require(bond[msg.sender] >= lockedBond[msg.sender] + minimumBond, "insufficient bond");
        lockedBond[msg.sender] += minimumBond;
        service.state = State.Accepted;
        emit ServiceAccepted(id);
    }

    function attestService(uint256 id, bytes32 evidenceHash) external onlyAttestor nonReentrant {
        Service storage service = services[id];
        require(service.state == State.Accepted && block.timestamp < service.deadline, "not active");
        if (service.voteGeneration != committeeGeneration) {
            service.voteGeneration = committeeGeneration; service.approvals = 0; service.evidenceHash = 0;
        }
        require(evidenceHash != 0 && serviceVotes[id][msg.sender] != committeeGeneration, "empty/replayed vote");
        if (service.evidenceHash == 0) service.evidenceHash = evidenceHash;
        require(service.evidenceHash == evidenceHash, "different evidence");
        serviceVotes[id][msg.sender] = committeeGeneration;
        if (++service.approvals == approvalThreshold) {
            service.state = State.Paid; serviceEscrow -= service.amount;
            lockedBond[service.provider] -= minimumBond;
            token.safeTransfer(service.provider, service.amount);
            emit ServiceSettled(id, evidenceHash);
        }
    }

    function refundService(uint256 id) external nonReentrant {
        Service storage service = services[id];
        require(service.state == State.Open || service.state == State.Accepted, "not refundable");
        require(block.timestamp >= service.deadline, "not expired");
        if (service.state == State.Accepted) lockedBond[service.provider] -= minimumBond;
        service.state = State.Refunded; serviceEscrow -= service.amount;
        token.safeTransfer(service.requester, service.amount);
        emit ServiceRefunded(id);
    }

    function openBounty(bytes32 specification, uint256 amount, uint64 deadline)
        external nonReentrant returns (uint256 id)
    {
        require(specification != 0 && amount > 0, "empty bounty");
        require(deadline > block.timestamp && deadline <= block.timestamp + 365 days, "deadline");
        id = nextBounty++;
        Bounty storage bounty = bounties[id];
        bounty.sponsor = msg.sender; bounty.specification = specification; bounty.amount = amount;
        bounty.deadline = deadline; bounty.state = State.Open; bounty.voteGeneration = committeeGeneration;
        bountyEscrow += amount; token.safeTransferFrom(msg.sender, address(this), amount);
        emit BountyOpened(id, msg.sender, amount, specification);
    }

    function attestBounty(uint256 id, address recipient, bytes32 resourceId, bytes32 evidenceHash)
        external onlyAttestor
    {
        Bounty storage bounty = bounties[id];
        require(bounty.state == State.Open && block.timestamp < bounty.deadline, "not open");
        require(recipient != address(0) && publications[resourceId].publisher == recipient, "publisher mismatch");
        if (bounty.voteGeneration != committeeGeneration) {
            bounty.voteGeneration = committeeGeneration; bounty.approvals = 0;
            bounty.recipient = address(0); bounty.resourceId = 0; bounty.evidenceHash = 0;
        }
        require(evidenceHash != 0 && bountyVotes[id][msg.sender] != committeeGeneration, "empty/replayed vote");
        if (bounty.approvals == 0) {
            bounty.recipient = recipient; bounty.resourceId = resourceId; bounty.evidenceHash = evidenceHash;
        }
        require(bounty.recipient == recipient && bounty.resourceId == resourceId && bounty.evidenceHash == evidenceHash, "different evidence");
        bountyVotes[id][msg.sender] = committeeGeneration;
        if (++bounty.approvals == approvalThreshold) {
            bounty.state = State.Accepted; bounty.readyAt = uint64(block.timestamp) + reviewDelay;
            emit BountyApproved(id, recipient, resourceId, evidenceHash, bounty.readyAt);
        }
    }

    function claimBounty(uint256 id) external nonReentrant {
        Bounty storage bounty = bounties[id];
        require(bounty.state == State.Accepted && block.timestamp >= bounty.readyAt, "not ready");
        bounty.state = State.Paid; bountyEscrow -= bounty.amount;
        token.safeTransfer(bounty.recipient, bounty.amount);
        emit BountyPaid(id, bounty.recipient, bounty.amount);
    }

    /// @notice Bootstrap administrator may veto during review; sponsor refund after timeout.
    function refundBounty(uint256 id) external nonReentrant {
        Bounty storage bounty = bounties[id];
        bool expired = bounty.state == State.Open && block.timestamp >= bounty.deadline;
        bool veto = bounty.state == State.Accepted && block.timestamp < bounty.readyAt && msg.sender == owner();
        require(expired || veto, "not refundable");
        bounty.state = State.Refunded; bountyEscrow -= bounty.amount;
        token.safeTransfer(bounty.sponsor, bounty.amount);
        emit BountyRefunded(id);
    }

    /// @notice Owner proposes a fully prefunded root. No minting or unbacked promises.
    function proposeEpoch(bytes32 root, uint256 budget, uint64 claimSeconds)
        external onlyOwner nonReentrant returns (uint256 id)
    {
        require(root != 0 && budget > 0, "empty epoch");
        require(claimSeconds >= 1 days && claimSeconds <= 90 days, "claim duration");
        id = nextEpoch++;
        uint64 ready = uint64(block.timestamp) + reviewDelay;
        epochs[id] = Epoch(msg.sender, root, budget, ready, ready + claimSeconds, false);
        rewardEscrow += budget; token.safeTransferFrom(msg.sender, address(this), budget);
        emit RewardEpochProposed(id, root, budget, ready, ready + claimSeconds);
    }

    function rewardLeaf(uint256 epochId, uint256 index, address recipient, uint256 amount, bytes32 evidenceHash)
        public view returns (bytes32)
    {
        // Double-hashed, domain-bound leaves match OpenZeppelin StandardMerkleTree semantics.
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), epochId, index, recipient, amount, evidenceHash))));
    }

    function claimReward(uint256 epochId, uint256 index, address recipient, uint256 amount,
        bytes32 evidenceHash, bytes32[] calldata proof) external nonReentrant
    {
        Epoch storage epoch = epochs[epochId];
        require(!epoch.closed && epoch.readyAt != 0 && block.timestamp >= epoch.readyAt && block.timestamp < epoch.expiresAt, "epoch not active");
        require(!claimed[epochId][index] && recipient != address(0) && amount > 0 && evidenceHash != 0, "invalid/replayed claim");
        require(amount <= epoch.remaining && MerkleProof.verifyCalldata(proof, epoch.root, rewardLeaf(epochId, index, recipient, amount, evidenceHash)), "invalid proof/budget");
        claimed[epochId][index] = true; epoch.remaining -= amount; rewardEscrow -= amount;
        token.safeTransfer(recipient, amount);
        emit RewardClaimed(epochId, index, recipient, amount, evidenceHash);
    }

    function closeEpoch(uint256 id) external nonReentrant {
        Epoch storage epoch = epochs[id];
        require(!epoch.closed && epoch.readyAt != 0, "not open");
        require(block.timestamp >= epoch.expiresAt || (msg.sender == owner() && block.timestamp < epoch.readyAt), "not closable");
        epoch.closed = true;
        uint256 remaining = epoch.remaining; epoch.remaining = 0; rewardEscrow -= remaining;
        token.safeTransfer(epoch.funder, remaining);
        emit RewardEpochClosed(id, remaining);
    }

    function accountedBalance() external view returns (uint256) {
        return totalBond + serviceEscrow + bountyEscrow + rewardEscrow;
    }
}
