//SPDX-License-Identifier: MIT
pragma solidity >=0.8.4;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * A manually-updated USD price feed with the same interface as the
 * Chainlink AggregatorInterface consumed by StablePriceOracle.
 *
 * Electroneum has no on-chain ETN/USD oracle, so the feed value is set
 * by the contract owner and updated as the ETN price moves. The value
 * uses 8 decimals, matching Chainlink USD feeds (e.g. an ETN price of
 * $0.00086 is stored as 86000).
 */
contract OwnedUsdOracle is Ownable {
    int256 private value;

    event ValueChanged(int256 value);

    constructor(int256 _value) {
        set(_value);
    }

    function set(int256 _value) public onlyOwner {
        value = _value;
        emit ValueChanged(_value);
    }

    function latestAnswer() public view returns (int256) {
        return value;
    }
}
