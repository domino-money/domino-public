// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// A token that taxes only what pools send (a "buy tax"), as many fee-on-
/// transfer tokens do; transfers into a pool, or between wallets, are whole.
contract BuyTaxToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public taxedSender;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setTaxedSender(address account, bool value) external {
        taxedSender[account] = value;
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _transfer(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        return _transfer(from, to, amount);
    }

    /// 1% of what a taxed sender (a pool) sends is burned.
    function _transfer(address from, address to, uint256 amount) private returns (bool) {
        require(!blocked[to], "blocked");
        balanceOf[from] -= amount;
        balanceOf[to] += taxedSender[from] ? amount - amount / 100 : amount;
        return true;
    }
}
