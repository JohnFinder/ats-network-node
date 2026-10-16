// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Wallet-authorized identity commitments. Ed25519 MUST be independently verified off chain.
/// @dev No contract-side Ed25519 verification, legal identity assertion, or trusted identity badge.
contract ATSIdentityRegistry is EIP712 {
    bytes32 public constant BIND_TYPEHASH = keccak256("Bind(address wallet,bytes32 fingerprint,bytes32 edProofHash,uint256 nonce,uint64 expiresAt)");
    bytes32 public constant REVOKE_TYPEHASH = keccak256("Revoke(address wallet,uint256 nonce,uint64 expiresAt)");
    struct Binding { bytes32 fingerprint; bytes32 edProofHash; uint64 expiresAt; }
    mapping(address => Binding) public bindings;
    mapping(address => uint256) public nonces;
    event Bound(address indexed wallet, bytes32 indexed fingerprint, bytes32 edProofHash, uint256 nonce, uint64 expiresAt);
    event Revoked(address indexed wallet, bytes32 indexed fingerprint, uint256 nonce);
    constructor() EIP712("ATSIdentityRegistry", "1") {}
    function bindFor(address wallet, bytes32 fingerprint, bytes32 edProofHash, uint256 nonce, uint64 expiresAt, bytes calldata signature) external {
        require(wallet != address(0) && fingerprint != 0 && edProofHash != 0, "empty binding");
        require(expiresAt > block.timestamp && expiresAt <= block.timestamp + 366 days, "binding expiry");
        require(nonce == nonces[wallet], "nonce");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(BIND_TYPEHASH, wallet, fingerprint, edProofHash, nonce, expiresAt)));
        require(ECDSA.recover(digest, signature) == wallet, "wallet signature");
        nonces[wallet] = nonce + 1;
        bindings[wallet] = Binding(fingerprint, edProofHash, expiresAt);
        emit Bound(wallet, fingerprint, edProofHash, nonce, expiresAt);
    }
    function revoke() external { _revoke(msg.sender); }
    function revokeFor(address wallet, uint256 nonce, uint64 expiresAt, bytes calldata signature) external {
        require(nonce == nonces[wallet] && expiresAt > block.timestamp, "nonce/expiry");
        require(ECDSA.recover(_hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPEHASH, wallet, nonce, expiresAt))), signature) == wallet, "wallet signature");
        _revoke(wallet);
    }
    function _revoke(address wallet) private {
        Binding memory previous = bindings[wallet];
        delete bindings[wallet];
        uint256 nonce = nonces[wallet]++;
        emit Revoked(wallet, previous.fingerprint, nonce);
    }
    function isActive(address wallet) public view returns (bool) {
        Binding storage b = bindings[wallet];
        return b.fingerprint != 0 && b.expiresAt > block.timestamp;
    }
}
