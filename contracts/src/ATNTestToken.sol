// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Local/test-network currency. Fixed supply; there is no external mint.
/// @dev This is not a mainnet token, investment product, or promise of value.
contract ATNTestToken is ERC20 {
    uint256 public constant CAP = 100_000_000 ether;

    constructor(address treasury) ERC20("ATS Network TEST ONLY", "tATN") {
        require(treasury != address(0), "zero treasury");
        _mint(treasury, CAP);
    }
}
