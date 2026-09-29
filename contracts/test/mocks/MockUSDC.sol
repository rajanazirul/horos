// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.37;

/// @dev Minimal mintable ERC-20 stand-in for Arc USDC, etched at `0x3600…` in unit tests.
///      Upstream Foundry cannot run the real transfer (it calls Arc's NativeCoinAuthority precompile).
///      Balances are independent of native balances. `transfer` returns `true` or reverts.
contract MockUSDC {
    mapping(address => uint256) public balanceOf;

    /// @dev When true, `transfer` moves nothing and returns `false` (a non-reverting failure).
    bool public returnFalse;

    error InsufficientBalance(uint256 balance, uint256 needed);

    event Transfer(address indexed from, address indexed to, uint256 value);

    function decimals() external pure returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        if (returnFalse) return false;
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance(bal, amount);
        unchecked {
            balanceOf[msg.sender] = bal - amount;
        }
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
}
