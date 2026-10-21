// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ATSPublicationRegistry} from "./ATSPublicationRegistry.sol";

/// @notice Prepaid fixed-price retention orders with period accrual and reviewable committee reports.
/// @dev The administrator/observer threshold is TRUSTED. These are retrieval observations,
/// not Filecoin replica proofs, a fiat price oracle, or Sybil-resistant replica certification.
contract ATSStorageMarket is Ownable2Step, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    ATSPublicationRegistry public immutable registry;
    uint256 public immutable minimumBond;
    uint64 public immutable reviewDelay;
    uint64 public immutable reportGrace;
    uint64 public immutable unbondDelay;
    uint64 public constant MAX_EVIDENCE_AGE = 1 hours;
    uint8 public immutable threshold;
    uint64 public committeeGeneration = 1;
    uint256 public observerCount;
    mapping(address => bool) public observers;
    mapping(address => uint256) public bond;
    mapping(address => uint256) public lockedBond;
    mapping(address => uint64) public unbondAt;
    uint256 public totalBond;
    uint256 public escrow;
    bytes32 public constant QUOTE_TYPEHASH = keccak256("Quote(address requester,address provider,bytes32 publicationId,bytes32 archiveHash,uint64 start,uint64 end,uint64 period,uint256 amount,bytes32 salt,uint64 expiresAt)");
    bytes32 public constant OPEN_TYPEHASH = keccak256("OpenOrder(bytes32 quoteHash,uint256 nonce,uint64 expiresAt)");
    struct Quote { address requester; address provider; bytes32 publicationId; bytes32 archiveHash; uint64 start; uint64 end; uint64 period; uint256 amount; bytes32 salt; uint64 expiresAt; }
    struct Order { address requester; address provider; bytes32 publicationId; bytes32 archiveHash; uint64 start; uint64 end; uint64 period; uint32 settledPeriods; uint256 amount; uint256 remaining; bool closed; }
    struct Report { uint256 orderId; uint32 periodIndex; uint64 from; uint64 to; uint64 observedAt; uint32 samples; uint32 successful; bytes32 evidenceHash; }
    struct Pending { bytes32 candidate; bytes32 evidenceHash; uint64 readyAt; uint64 generation; uint32 round; uint32 successful; uint32 samples; bool challenged; }
    mapping(uint256 => Order) public orders;
    /// @notice Settled, successful service time for ONE order; parallel copies cannot accelerate this clock.
    mapping(uint256 => uint64) public paidServiceSeconds;
    mapping(uint256 => Pending) public pending;
    mapping(uint256 => uint32) public rounds;
    mapping(bytes32 => uint8) public approvals;
    mapping(bytes32 => mapping(address => bool)) public votes;
    mapping(bytes32 => bool) public usedQuotes;
    mapping(address => uint256) public nonces;
    uint256 public nextOrder = 1;
    event ObserverChanged(address indexed observer, bool enabled, uint64 generation);
    event Bonded(address indexed provider, uint256 amount);
    event UnbondRequested(address indexed provider, uint64 readyAt);
    event Unbonded(address indexed provider, uint256 amount);
    event OrderOpened(uint256 indexed orderId, address indexed requester, address indexed provider, bytes32 publicationId, bytes32 archiveHash, uint64 start, uint64 end, uint64 period, uint256 amount, bytes32 quoteHash);
    event ReportVoted(uint256 indexed orderId, bytes32 indexed candidate, address indexed observer, uint8 approvals);
    event ReportApproved(uint256 indexed orderId, uint32 indexed periodIndex, bytes32 candidate, bytes32 evidenceHash, uint64 readyAt, uint32 samples, uint32 successful);
    event ReportChallenged(uint256 indexed orderId, address indexed challenger, bytes32 reasonHash);
    event ChallengeResolved(uint256 indexed orderId, bool accepted, bytes32 resolutionHash);
    event ServiceTimeAccrued(uint256 indexed orderId, bytes32 indexed publicationId, uint64 secondsAdded, uint64 totalSeconds);
    event PeriodSettled(uint256 indexed orderId, uint32 indexed periodIndex, uint256 paid, uint256 refunded, bytes32 evidenceHash);
    event OrderRefunded(uint256 indexed orderId, uint256 amount);
    constructor(IERC20 asset, ATSPublicationRegistry publicationRegistry, address administrator, address[] memory initialObservers,
        uint8 approvalThreshold, uint256 bondPerOrder, uint64 reviewSeconds, uint64 graceSeconds, uint64 unbondSeconds)
        Ownable(administrator) EIP712("ATSStorageMarket", "1")
    {
        require(address(asset) != address(0) && address(publicationRegistry) != address(0) && address(publicationRegistry.token()) == address(asset), "dependencies");
        require(bondPerOrder > 0 && reviewSeconds >= 60 && graceSeconds >= reviewSeconds * 2 && unbondSeconds >= 60, "parameters");
        require(initialObservers.length <= 32 && approvalThreshold >= 2 && approvalThreshold <= initialObservers.length, "committee");
        token = asset; registry = publicationRegistry; minimumBond = bondPerOrder; threshold = approvalThreshold;
        reviewDelay = reviewSeconds; reportGrace = graceSeconds; unbondDelay = unbondSeconds;
        for (uint256 i; i < initialObservers.length; ++i) {
            address account = initialObservers[i];
            require(account != address(0) && !observers[account], "observer");
            observers[account] = true; emit ObserverChanged(account, true, 1);
        }
        observerCount = initialObservers.length;
    }
    function setObserver(address account, bool enabled) external onlyOwner {
        require(account != address(0) && observers[account] != enabled, "change");
        if (enabled) { require(observerCount < 32, "committee full"); ++observerCount; }
        else { require(observerCount > threshold, "threshold"); --observerCount; }
        observers[account] = enabled; ++committeeGeneration;
        emit ObserverChanged(account, enabled, committeeGeneration);
    }
    function _receive(address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "unsupported token");
    }
    function stake(uint256 amount) external nonReentrant {
        require(amount > 0, "amount"); bond[msg.sender] += amount; totalBond += amount; unbondAt[msg.sender] = 0;
        _receive(msg.sender, amount); emit Bonded(msg.sender, amount);
    }
    function requestUnbond() external {
        require(bond[msg.sender] > 0 && lockedBond[msg.sender] == 0, "bond locked");
        unbondAt[msg.sender] = uint64(block.timestamp) + unbondDelay; emit UnbondRequested(msg.sender, unbondAt[msg.sender]);
    }
    function withdrawBond() external nonReentrant {
        require(unbondAt[msg.sender] > 0 && block.timestamp >= unbondAt[msg.sender] && lockedBond[msg.sender] == 0, "not ready");
        uint256 amount = bond[msg.sender]; require(amount > 0, "empty bond");
        delete bond[msg.sender]; delete unbondAt[msg.sender]; totalBond -= amount;
        token.safeTransfer(msg.sender, amount); emit Unbonded(msg.sender, amount);
    }
    function quoteHash(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(QUOTE_TYPEHASH, q.requester, q.provider, q.publicationId, q.archiveHash, q.start, q.end, q.period, q.amount, q.salt, q.expiresAt)));
    }
    function openOrder(Quote calldata q, bytes calldata providerSignature) external nonReentrant returns (uint256) {
        require(msg.sender == q.requester, "requester"); return _open(q, providerSignature);
    }
    function openOrderFor(Quote calldata q, bytes calldata providerSignature, uint256 nonce, uint64 expiresAt, bytes calldata requesterSignature) external nonReentrant returns (uint256) {
        require(expiresAt > block.timestamp && nonce == nonces[q.requester], "nonce/expiry");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(OPEN_TYPEHASH, quoteHash(q), nonce, expiresAt)));
        require(ECDSA.recover(digest, requesterSignature) == q.requester, "requester signature");
        ++nonces[q.requester]; return _open(q, providerSignature);
    }
    function _open(Quote calldata q, bytes calldata providerSignature) private returns (uint256 id) {
        require(q.requester != address(0) && q.provider != address(0) && q.provider != q.requester && q.amount > 0 && q.salt != 0, "quote");
        require(q.expiresAt > block.timestamp && q.expiresAt <= q.start && q.start >= block.timestamp && q.start <= block.timestamp + 7 days, "quote expiry/start");
        require(q.end > q.start && q.end <= q.start + 366 days && q.period >= 60 && (q.end - q.start) % q.period == 0 && (q.end - q.start) / q.period <= 366, "retention");
        require(q.amount >= (q.end - q.start) / q.period, "period budget");
        (address publisher, bytes32 archiveHash,,,,) = registry.publications(q.publicationId);
        require(publisher != address(0) && archiveHash == q.archiveHash && registry.identities().isActive(q.provider), "publication/provider");
        bytes32 hash = quoteHash(q); require(!usedQuotes[hash] && ECDSA.recover(hash, providerSignature) == q.provider, "quote signature/replay");
        require(unbondAt[q.provider] == 0 && bond[q.provider] >= lockedBond[q.provider] + minimumBond, "bond");
        usedQuotes[hash] = true; lockedBond[q.provider] += minimumBond; escrow += q.amount;
        id = nextOrder++;
        orders[id] = Order(q.requester, q.provider, q.publicationId, q.archiveHash, q.start, q.end, q.period, 0, q.amount, q.amount, false);
        _receive(q.requester, q.amount);
        emit OrderOpened(id, q.requester, q.provider, q.publicationId, q.archiveHash, q.start, q.end, q.period, q.amount, hash);
    }
    function periodTimes(uint256 id, uint32 index) public view returns (uint64 from, uint64 to) {
        Order storage order = orders[id];
        require(order.requester != address(0) && index < (order.end - order.start) / order.period, "period index");
        from = order.start + uint64(index) * order.period; to = from + order.period;
    }
    function serviceWindow(uint256 id) external view returns (uint64 start, uint64 end) {
        return (orders[id].start, orders[id].end);
    }
    function orderService(uint256 id) external view returns (bytes32 publicationId, uint64 successfulSeconds) {
        return (orders[id].publicationId, paidServiceSeconds[id]);
    }
    function reportCandidate(Report calldata report) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), committeeGeneration, rounds[report.orderId], report));
    }
    function attestPeriod(Report calldata report) external {
        require(observers[msg.sender], "observer");
        Order storage order = orders[report.orderId];
        require(!order.closed && order.requester != address(0) && report.periodIndex == order.settledPeriods, "order/period");
        (uint64 from, uint64 to) = periodTimes(report.orderId, report.periodIndex);
        require(report.from == from && report.to == to && block.timestamp >= to, "period not complete");
        require(block.timestamp <= to + reportGrace && report.observedAt >= to && report.observedAt <= block.timestamp && block.timestamp - report.observedAt <= MAX_EVIDENCE_AGE, "stale evidence");
        require(report.evidenceHash != 0 && report.samples > 0 && report.samples <= 10000 && report.successful <= report.samples, "samples");
        Pending storage p = pending[report.orderId];
        if (p.candidate != 0 && p.generation != committeeGeneration) delete pending[report.orderId];
        require(pending[report.orderId].candidate == 0, "report in review");
        bytes32 candidate = reportCandidate(report);
        require(!votes[candidate][msg.sender], "vote replay"); votes[candidate][msg.sender] = true;
        uint8 count = ++approvals[candidate]; emit ReportVoted(report.orderId, candidate, msg.sender, count);
        if (count == threshold) {
            uint64 readyAt = uint64(block.timestamp) + reviewDelay;
            pending[report.orderId] = Pending(candidate, report.evidenceHash, readyAt, committeeGeneration, rounds[report.orderId], report.successful, report.samples, false);
            emit ReportApproved(report.orderId, report.periodIndex, candidate, report.evidenceHash, readyAt, report.samples, report.successful);
        }
    }
    function challengePeriod(uint256 id, bytes32 reasonHash) external {
        Order storage order = orders[id]; Pending storage p = pending[id];
        require(msg.sender == order.requester || msg.sender == order.provider || msg.sender == owner(), "challenger");
        require(p.candidate != 0 && block.timestamp < p.readyAt && !p.challenged && reasonHash != 0, "review");
        p.challenged = true; emit ReportChallenged(id, msg.sender, reasonHash);
    }
    /// @notice Trusted administrator resolution. Rejections reopen the period with a new round.
    function resolveChallenge(uint256 id, bool accepted, bytes32 resolutionHash) external onlyOwner {
        Pending storage p = pending[id]; require(p.challenged && resolutionHash != 0, "no challenge/reason");
        if (accepted) { p.challenged = false; p.readyAt = uint64(block.timestamp) + reviewDelay; }
        else { delete pending[id]; ++rounds[id]; }
        emit ChallengeResolved(id, accepted, resolutionHash);
    }
    function settlePeriod(uint256 id) external nonReentrant {
        Order storage order = orders[id]; Pending memory p = pending[id];
        require(!order.closed && p.candidate != 0 && !p.challenged && p.generation == committeeGeneration && p.round == rounds[id] && block.timestamp >= p.readyAt, "not ready");
        (, uint64 to) = periodTimes(id, order.settledPeriods); require(block.timestamp >= to, "period incomplete");
        uint32 index = order.settledPeriods++;
        uint256 periods = (order.end - order.start) / order.period;
        uint256 allocation = index + 1 == periods ? order.remaining : order.amount / periods;
        uint256 paid = Math.mulDiv(allocation, p.successful, p.samples);
        uint256 refunded = allocation - paid;
        // Only final, reviewed settlements accrue. A failed or unresolved period adds zero.
        // Floor each fraction conservatively; this measures committee-observed service, not replica proof.
        uint64 successfulSeconds = uint64(Math.mulDiv(order.period, p.successful, p.samples));
        if (paid > 0 && successfulSeconds > 0) {
            paidServiceSeconds[id] += successfulSeconds;
            emit ServiceTimeAccrued(id, order.publicationId, successfulSeconds, paidServiceSeconds[id]);
        }
        order.remaining -= allocation; escrow -= allocation; delete pending[id]; ++rounds[id];
        if (order.settledPeriods == periods) { order.closed = true; lockedBond[order.provider] -= minimumBond; }
        if (paid > 0) token.safeTransfer(order.provider, paid);
        if (refunded > 0) token.safeTransfer(order.requester, refunded);
        emit PeriodSettled(id, index, paid, refunded, p.evidenceHash);
    }
    /// @notice Bounded exit even if observers or administrator disappear; unresolved balance refunds.
    function refundRemaining(uint256 id) external nonReentrant {
        Order storage order = orders[id]; require(order.requester != address(0) && !order.closed, "not open");
        require(block.timestamp > order.end + reportGrace + reviewDelay * 2, "retention/review active");
        uint256 amount = order.remaining; order.remaining = 0; order.closed = true;
        escrow -= amount; lockedBond[order.provider] -= minimumBond; delete pending[id];
        token.safeTransfer(order.requester, amount); emit OrderRefunded(id, amount);
    }
    function accountedBalance() external view returns (uint256) { return totalBond + escrow; }
}
