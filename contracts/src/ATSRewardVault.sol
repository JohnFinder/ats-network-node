// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @notice Bounded prefunded supplemental rewards. Root selection remains a trusted governance act.
contract ATSRewardVault is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    uint64 public immutable reviewDelay;
    uint256 public rewardEscrow;
    uint256 public nextEpoch = 1;
    struct Epoch { address funder; bytes32 root; uint256 remaining; uint64 readyAt; uint64 expiresAt; bool closed; }
    mapping(uint256 => Epoch) public epochs;
    mapping(uint256 => mapping(uint256 => bool)) public claimed;
    event RewardEpochProposed(uint256 indexed epochId, bytes32 root, uint256 budget, uint64 readyAt, uint64 expiresAt);
    event RewardClaimed(uint256 indexed epochId, uint256 indexed index, address indexed recipient, uint256 amount, bytes32 evidenceHash);
    event RewardEpochClosed(uint256 indexed epochId, uint256 refund);
    constructor(IERC20 asset, address administrator, uint64 reviewSeconds) Ownable(administrator) {
        require(address(asset) != address(0) && reviewSeconds >= 60, "parameters"); token = asset; reviewDelay = reviewSeconds;
    }
    function proposeEpoch(bytes32 root, uint256 budget, uint64 claimSeconds) external onlyOwner nonReentrant returns (uint256 id) {
        require(root != 0 && budget > 0 && claimSeconds >= 1 days && claimSeconds <= 90 days, "epoch");
        id = nextEpoch++; uint64 ready = uint64(block.timestamp) + reviewDelay;
        epochs[id] = Epoch(msg.sender, root, budget, ready, ready + claimSeconds, false);
        rewardEscrow += budget; uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), budget); require(token.balanceOf(address(this)) == beforeBalance + budget, "unsupported token");
        emit RewardEpochProposed(id, root, budget, ready, ready + claimSeconds);
    }
    function rewardLeaf(uint256 epochId, uint256 index, address recipient, uint256 amount, bytes32 evidenceHash) public view returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(block.chainid, address(this), epochId, index, recipient, amount, evidenceHash))));
    }
    function claimReward(uint256 epochId, uint256 index, address recipient, uint256 amount, bytes32 evidenceHash, bytes32[] calldata proof) external nonReentrant {
        Epoch storage epoch = epochs[epochId];
        require(!epoch.closed && epoch.readyAt != 0 && block.timestamp >= epoch.readyAt && block.timestamp < epoch.expiresAt, "inactive");
        require(!claimed[epochId][index] && recipient != address(0) && amount > 0 && evidenceHash != 0 && amount <= epoch.remaining && proof.length <= 32, "claim/budget");
        require(MerkleProof.verifyCalldata(proof, epoch.root, rewardLeaf(epochId, index, recipient, amount, evidenceHash)), "proof");
        claimed[epochId][index] = true; epoch.remaining -= amount; rewardEscrow -= amount;
        token.safeTransfer(recipient, amount); emit RewardClaimed(epochId, index, recipient, amount, evidenceHash);
    }
    function closeEpoch(uint256 id) external nonReentrant {
        Epoch storage epoch = epochs[id]; require(!epoch.closed && epoch.readyAt != 0, "not open");
        require(block.timestamp >= epoch.expiresAt || (msg.sender == owner() && block.timestamp < epoch.readyAt), "not closable");
        epoch.closed = true; uint256 remaining = epoch.remaining; epoch.remaining = 0; rewardEscrow -= remaining;
        token.safeTransfer(epoch.funder, remaining); emit RewardEpochClosed(id, remaining);
    }
}
