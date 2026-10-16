// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ATSIdentityRegistry} from "./ATSIdentityRegistry.sol";

/// @notice Immutable publisher-scoped content commitments and optional fixed token royalties.
/// @dev A publisher signature is not a copyright or audio-quality attestation.
contract ATSPublicationRegistry is EIP712, ReentrancyGuard {
    using SafeERC20 for IERC20;
    ATSIdentityRegistry public immutable identities;
    IERC20 public immutable token;
    bytes32 public constant PUBLISH_TYPEHASH = keccak256("Publish(address wallet,bytes32 archiveHash,bytes32 metadataHash,bytes32 previous,bytes32 royaltiesHash,uint256 nonce,uint64 expiresAt)");
    struct Publication { address publisher; bytes32 archiveHash; bytes32 metadataHash; bytes32 previous; bytes32 fingerprint; bytes32 royaltiesHash; }
    mapping(bytes32 => Publication) public publications;
    mapping(bytes32 => address[]) private payees;
    mapping(bytes32 => uint16[]) private shares;
    mapping(address => uint256) public nonces;
    event Published(bytes32 indexed publicationId, address indexed publisher, bytes32 archiveHash, bytes32 metadataHash, bytes32 previous, bytes32 fingerprint, bytes32 royaltiesHash);
    event RoyaltyPaid(bytes32 indexed publicationId, address indexed payer, uint256 amount);
    constructor(ATSIdentityRegistry identityRegistry, IERC20 asset) EIP712("ATSPublicationRegistry", "1") {
        require(address(identityRegistry) != address(0) && address(asset) != address(0), "empty dependency");
        identities = identityRegistry; token = asset;
    }
    function publicationID(address publisher, bytes32 archiveHash) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this), publisher, archiveHash));
    }
    function royaltiesHash(address[] calldata recipients, uint16[] calldata bps) public pure returns (bytes32) {
        require(recipients.length > 0 && recipients.length <= 16 && recipients.length == bps.length, "royalty count");
        uint256 sum;
        for (uint256 i; i < recipients.length; ++i) {
            require(recipients[i] != address(0) && bps[i] > 0, "empty royalty");
            for (uint256 j; j < i; ++j) require(recipients[i] != recipients[j], "duplicate payee");
            sum += bps[i];
        }
        require(sum == 10000, "royalty sum");
        return keccak256(abi.encode(recipients, bps));
    }
    function publishFor(address wallet, bytes32 archiveHash, bytes32 metadataHash, bytes32 previous,
        address[] calldata recipients, uint16[] calldata bps, uint256 nonce, uint64 expiresAt, bytes calldata signature)
        external returns (bytes32 id)
    {
        require(identities.isActive(wallet), "inactive identity");
        require(expiresAt > block.timestamp && nonce == nonces[wallet], "nonce/expiry");
        bytes32 splitHash = royaltiesHash(recipients, bps);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(PUBLISH_TYPEHASH, wallet, archiveHash, metadataHash, previous, splitHash, nonce, expiresAt)));
        require(ECDSA.recover(digest, signature) == wallet, "publisher signature");
        require(archiveHash != 0 && metadataHash != 0, "empty publication");
        id = publicationID(wallet, archiveHash);
        require(publications[id].publisher == address(0), "already published");
        if (previous != 0) require(publications[previous].publisher == wallet, "previous publisher");
        (bytes32 fingerprint,,) = identities.bindings(wallet);
        publications[id] = Publication(wallet, archiveHash, metadataHash, previous, fingerprint, splitHash);
        payees[id] = recipients; shares[id] = bps; ++nonces[wallet];
        emit Published(id, wallet, archiveHash, metadataHash, previous, fingerprint, splitHash);
    }
    function royaltySplit(bytes32 id) external view returns (address[] memory, uint16[] memory) { return (payees[id], shares[id]); }
    function payRoyalty(bytes32 id, uint256 amount) external nonReentrant {
        require(publications[id].publisher != address(0) && amount > 0, "unknown/empty");
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "unsupported token");
        uint256 distributed;
        uint256 length = payees[id].length;
        for (uint256 i; i < length; ++i) {
            uint256 part = i + 1 == length ? amount - distributed : amount / 10000 * shares[id][i] + amount % 10000 * shares[id][i] / 10000;
            distributed += part;
            token.safeTransfer(payees[id][i], part);
        }
        emit RoyaltyPaid(id, msg.sender, amount);
    }
}
