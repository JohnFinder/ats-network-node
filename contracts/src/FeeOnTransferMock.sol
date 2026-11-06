// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.30;

/// @notice Negative-test token only. It is not a currency and must never be deployed as tATN.
contract FeeOnTransferMock {
    mapping(address => uint256) public balanceOf;
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address, uint256) external pure returns (bool) { return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        balanceOf[from] -= amount;
        balanceOf[to] += amount / 2;
        return true;
    }
}
