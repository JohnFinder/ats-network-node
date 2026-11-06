// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Personal voice-license escrow for a non-rebasing 18-decimal token.
/// @dev Not a proxy and not a mainnet asset. Ledger prices use 100 units per token.
///      One ledger unit converts as `10^16` atomic units. Shares are floored in ledger
///      units, then scaled, so the three shares add up to the exact payment. A refund
///      revokes the personal license and does not allow the same buyer to repurchase it.
contract VoiceLicenseSettlement is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant PACKAGE_KEY_VERSION = 2;
    uint256 public constant LEDGER_UNITS_PER_TOKEN = 100;
    uint256 public constant ATOMIC_PER_LEDGER_UNIT = 10 ** 16;
    uint256 public constant MAX_LEDGER_UNITS = 100_000_000;
    uint16 public constant PUBLISHER_BASIS_POINTS = 8000;
    uint16 public constant OPERATOR_BASIS_POINTS = 1500;
    uint8 public constant KIND_NONCOMMERCIAL = 1;
    uint8 public constant KIND_COMMERCIAL = 2;
    uint8 private constant RESERVED = 1;
    uint8 private constant REFUNDED = 2;
    uint8 private constant SETTLED = 3;
    uint8 private constant LICENSE_ACTIVE = 1;
    uint8 private constant LICENSE_REVOKED = 2;

    IERC20 public immutable token;
    address public immutable administrator;
    address public immutable operator;
    address public immutable platform;
    uint64 public immutable holdSeconds;

    struct Package {
        address holder;
        uint256 commercialUnits;
        uint256 noncommercialUnits;
        bool active;
    }
    struct Order {
        address buyer;
        address holder;
        bytes32 packageId;
        uint8 kind;
        uint8 state;
        uint256 ledgerUnits;
        uint256 publisherAtomic;
        uint256 operatorAtomic;
        uint256 platformAtomic;
        uint64 createdAt;
    }

    uint256 public nextOrder;
    uint256 public escrow;
    mapping(bytes32 => Package) public packages;
    mapping(uint256 => Order) public orders;
    mapping(address => mapping(bytes32 => mapping(uint8 => uint8))) public licenseState;

    event PackageRegistered(bytes32 indexed packageId, address indexed holder, uint256 commercialUnits, uint256 noncommercialUnits, uint256 chainId);
    event PackageActive(bytes32 indexed packageId, bool active);
    event Purchased(uint256 indexed orderId, address indexed buyer, bytes32 indexed packageId, uint8 kind, uint256 ledgerUnits, uint256 atomicAmount, uint256 chainId);
    event Refunded(uint256 indexed orderId, address indexed buyer, uint256 atomicAmount, uint256 chainId);
    event Settled(uint256 indexed orderId, address indexed holder, address operator, address platform, uint256 publisherAtomic, uint256 operatorAtomic, uint256 platformAtomic, uint256 chainId);

    constructor(IERC20 asset, address administrator_, address operator_, address platform_, uint64 holdSeconds_) {
        require(address(asset) != address(0) && administrator_ != address(0) && operator_ != address(0) && platform_ != address(0), "parameters");
        require(holdSeconds_ >= 60 && holdSeconds_ <= 30 days, "hold");
        token = asset;
        administrator = administrator_;
        operator = operator_;
        platform = platform_;
        holdSeconds = holdSeconds_;
    }

    function quote(uint256 units) public pure returns (uint256 publisherAtomic, uint256 operatorAtomic, uint256 platformAtomic, uint256 totalAtomic) {
        require(units > 0 && units <= MAX_LEDGER_UNITS, "units");
        uint256 publisherUnits = units * PUBLISHER_BASIS_POINTS / 10_000;
        uint256 operatorUnits = units * OPERATOR_BASIS_POINTS / 10_000;
        publisherAtomic = publisherUnits * ATOMIC_PER_LEDGER_UNIT;
        operatorAtomic = operatorUnits * ATOMIC_PER_LEDGER_UNIT;
        platformAtomic = (units - publisherUnits - operatorUnits) * ATOMIC_PER_LEDGER_UNIT;
        totalAtomic = units * ATOMIC_PER_LEDGER_UNIT;
    }

    /// @notice Resource identifiers are namespaced by their publisher's wallet.
    /// @dev A third party registering the same public resource ID cannot reserve this key.
    function packageKey(address holder, bytes32 resourceId) public pure returns (bytes32) {
        return keccak256(abi.encode(holder, resourceId));
    }

    function registerPackage(bytes32 resourceId, uint256 commercialUnits, uint256 noncommercialUnits) external {
        bytes32 packageId = packageKey(msg.sender, resourceId);
        require(resourceId != bytes32(0) && packages[packageId].holder == address(0), "package");
        require(commercialUnits <= MAX_LEDGER_UNITS && noncommercialUnits <= MAX_LEDGER_UNITS, "price");
        require(commercialUnits > 0 || noncommercialUnits > 0, "price");
        packages[packageId] = Package(msg.sender, commercialUnits, noncommercialUnits, true);
        emit PackageRegistered(packageId, msg.sender, commercialUnits, noncommercialUnits, block.chainid);
    }

    function setPackageActive(bytes32 packageId, bool active_) external {
        require(packages[packageId].holder == msg.sender, "holder");
        packages[packageId].active = active_;
        emit PackageActive(packageId, active_);
    }

    function purchase(bytes32 packageId, uint8 kind) external nonReentrant returns (uint256 orderId) {
        Package storage package = packages[packageId];
        require(package.active && package.holder != address(0), "package");
        require(licenseState[msg.sender][packageId][kind] == 0, "license");
        uint256 units = kind == KIND_NONCOMMERCIAL ? package.noncommercialUnits : kind == KIND_COMMERCIAL ? package.commercialUnits : 0;
        (uint256 publisherAtomic, uint256 operatorAtomic, uint256 platformAtomic, uint256 totalAtomic) = quote(units);
        orderId = ++nextOrder;
        orders[orderId] = Order(msg.sender, package.holder, packageId, kind, RESERVED, units, publisherAtomic, operatorAtomic, platformAtomic, uint64(block.timestamp));
        licenseState[msg.sender][packageId][kind] = LICENSE_ACTIVE;
        escrow += totalAtomic;
        pull(msg.sender, totalAtomic);
        emit Purchased(orderId, msg.sender, packageId, kind, units, totalAtomic, block.chainid);
    }

    function refund(uint256 orderId) external nonReentrant {
        require(msg.sender == administrator, "administrator");
        Order storage order = orders[orderId];
        require(order.state == RESERVED && block.timestamp < uint256(order.createdAt) + holdSeconds, "refund");
        require(licenseState[order.buyer][order.packageId][order.kind] == LICENSE_ACTIVE, "license");
        uint256 total = order.publisherAtomic + order.operatorAtomic + order.platformAtomic;
        order.state = REFUNDED;
        licenseState[order.buyer][order.packageId][order.kind] = LICENSE_REVOKED;
        escrow -= total;
        push(order.buyer, total);
        emit Refunded(orderId, order.buyer, total, block.chainid);
    }

    function settle(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        require(order.state == RESERVED && block.timestamp >= uint256(order.createdAt) + holdSeconds, "settle");
        uint256 total = order.publisherAtomic + order.operatorAtomic + order.platformAtomic;
        order.state = SETTLED;
        escrow -= total;
        address holder = order.holder;
        push(holder, order.publisherAtomic);
        push(operator, order.operatorAtomic);
        push(platform, order.platformAtomic);
        emit Settled(orderId, holder, operator, platform, order.publisherAtomic, order.operatorAtomic, order.platformAtomic, block.chainid);
    }

    function pull(address from, uint256 amount) private {
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(from, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "unsupported token");
    }

    function push(address to, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransfer(to, amount);
        require(token.balanceOf(address(this)) == beforeBalance - amount, "unsupported token");
    }
}
