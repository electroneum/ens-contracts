//SPDX-License-Identifier: MIT
pragma solidity ~0.8.17;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

import {ETHRegistrarController} from "./ETHRegistrarController.sol";
import {IBulkRenewal} from "./IBulkRenewal.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {INameWrapper} from "../wrapper/INameWrapper.sol";

/// @title UniversalRegistrarRenewalWithReferrer (Electroneum implementation)
/// @notice Renews .etn names through the NameWrapper so that wrapper expiry
///         stays in sync with the registrar for wrapped names. Safe for
///         unwrapped names too: NameWrapper.renew extends the registrar and
///         skips wrapper state when the name is not wrapped, so this contract
///         can serve as the single renewal path for all names.
/// @dev    Unlike the upstream ENS contract of the same name (which delegates
///         to the 2023 wrapped controller, unavailable on Electroneum), this
///         implementation prices via the deployed ETHRegistrarController and
///         renews via NameWrapper.renew directly. It must be added as a
///         controller on the NameWrapper. Handles single (IRegistrarRenewal-
///         WithReferral-compatible) and bulk (IBulkRenewal) renewals.
contract UniversalRegistrarRenewalWithReferrer is Ownable, IBulkRenewal {
    ETHRegistrarController public immutable controller;
    INameWrapper public immutable nameWrapper;

    error InsufficientValue();

    /// @notice Emitted when a name is renewed. Identical shape to
    ///         ETHRegistrarController.NameRenewed so downstream indexing can
    ///         share event handlers.
    /// @param label The renewed label (eg. "name" for name.etn).
    /// @param labelhash The keccak256 hash of the label.
    /// @param cost The base rent paid for the renewal.
    /// @param expires The new expiry time of the name on the registrar.
    /// @param referrer The referrer of the renewal.
    event NameRenewed(
        string label,
        bytes32 indexed labelhash,
        uint256 cost,
        uint256 expires,
        bytes32 referrer
    );

    constructor(ETHRegistrarController _controller, INameWrapper _nameWrapper) {
        controller = _controller;
        nameWrapper = _nameWrapper;
    }

    /// @notice Renewal price for a single name. Only `base` is charged on
    ///         renewal; `premium` applies solely to post-expiry re-registration.
    function rentPrice(
        string calldata label,
        uint256 duration
    ) public view returns (IPriceOracle.Price memory price) {
        price = controller.rentPrice(label, duration);
    }

    /// @inheritdoc IBulkRenewal
    /// @dev Mirrors StaticBulkRenewal semantics (base + premium totals) so
    ///      clients estimating with either contract get identical results;
    ///      any overpayment is refunded by renewAll.
    function rentPrice(
        string[] calldata names,
        uint256 duration
    ) external view override returns (uint256 total) {
        uint256 length = names.length;
        for (uint256 i = 0; i < length; ) {
            IPriceOracle.Price memory price = controller.rentPrice(
                names[i],
                duration
            );
            unchecked {
                ++i;
                total += (price.base + price.premium);
            }
        }
    }

    /// @notice Renews a single name with referrer tracking, keeping wrapper
    ///         expiry in sync for wrapped names. Excess payment is refunded.
    function renew(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external payable {
        bytes32 labelhash = keccak256(bytes(label));

        IPriceOracle.Price memory price = controller.rentPrice(label, duration);
        if (msg.value < price.base) revert InsufficientValue();

        uint256 expires = nameWrapper.renew(uint256(labelhash), duration);

        emit NameRenewed(label, labelhash, price.base, expires, referrer);

        if (msg.value > price.base) {
            payable(msg.sender).transfer(msg.value - price.base);
        }
    }

    /// @inheritdoc IBulkRenewal
    function renewAll(
        string[] calldata names,
        uint256 duration,
        bytes32 referrer
    ) external payable override {
        uint256 length = names.length;
        uint256 total;
        for (uint256 i = 0; i < length; ) {
            string calldata label = names[i];
            bytes32 labelhash = keccak256(bytes(label));

            IPriceOracle.Price memory price = controller.rentPrice(
                label,
                duration
            );
            uint256 expires = nameWrapper.renew(uint256(labelhash), duration);

            emit NameRenewed(label, labelhash, price.base, expires, referrer);

            // Checked: `total` is compared against msg.value below, so an
            // overflow here must revert rather than wrap around.
            total += price.base;
            unchecked {
                ++i;
            }
        }
        if (msg.value < total) revert InsufficientValue();

        if (msg.value > total) {
            payable(msg.sender).transfer(msg.value - total);
        }
    }

    /// @notice Withdraws accumulated renewal fees to the owner.
    function withdraw() public {
        payable(owner()).transfer(address(this).balance);
    }

    function supportsInterface(bytes4 interfaceID) external pure returns (bool) {
        return
            interfaceID == type(IERC165).interfaceId ||
            interfaceID == type(IBulkRenewal).interfaceId;
    }
}
