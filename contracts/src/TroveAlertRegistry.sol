// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal read interfaces from github.com/mezo-org/musd (ITroveManager, IPriceFeed).
interface ITroveManagerView {
    function getCurrentICR(address borrower, uint256 price) external view returns (uint256);
    function getTroveStatus(address borrower) external view returns (uint256);
}

interface IPriceFeedView {
    function fetchPrice() external view returns (uint256);
}

/// @title TroveAlertRegistry
/// @notice MUSD borrowers on Mezo register a personal collateral-ratio alert threshold for their own trove.
/// Anyone (a bot, the TxExplain Worker, another dApp) can read whether a trove is under its threshold, and
/// anyone can `poke` to emit an on-chain AlertTriggered event that off-chain notifiers subscribe to.
/// Holds no funds, has no owner, and never calls state-changing functions on MUSD contracts.
contract TroveAlertRegistry {
    uint256 public constant MCR = 1.1e18; // 110%, LiquityBase.MCR in mezo-org/musd
    uint256 public constant MIN_THRESHOLD = 1.1e18;
    uint256 public constant MAX_THRESHOLD = 10e18; // 1000%
    uint256 public constant POKE_COOLDOWN = 1 hours;

    ITroveManagerView public immutable troveManager;
    IPriceFeedView public immutable priceFeed;

    struct Alert {
        uint128 threshold; // collateral ratio, 1e18 = 100%
        uint64 lastTriggered;
    }

    mapping(address => Alert) public alerts;

    event AlertSet(address indexed borrower, uint256 threshold);
    event AlertCleared(address indexed borrower);
    event AlertTriggered(address indexed borrower, uint256 icr, uint256 threshold, uint256 price);

    error ThresholdOutOfRange();
    error NoActiveTrove();
    error NoAlert();
    error NotBelowThreshold();
    error Cooldown();

    constructor(address _troveManager, address _priceFeed) {
        troveManager = ITroveManagerView(_troveManager);
        priceFeed = IPriceFeedView(_priceFeed);
    }

    /// @param threshold collateral ratio in 1e18 units, e.g. 1.6e18 = 160%.
    function setAlert(uint256 threshold) external {
        if (threshold < MIN_THRESHOLD || threshold > MAX_THRESHOLD) revert ThresholdOutOfRange();
        if (troveManager.getTroveStatus(msg.sender) != 1) revert NoActiveTrove();
        alerts[msg.sender] = Alert(uint128(threshold), 0);
        emit AlertSet(msg.sender, threshold);
    }

    function clearAlert() external {
        if (alerts[msg.sender].threshold == 0) revert NoAlert();
        delete alerts[msg.sender];
        emit AlertCleared(msg.sender);
    }

    /// @return active trove exists, icr current ratio, threshold user threshold (0 = none), below icr < threshold, liquidatable icr < MCR
    function check(address borrower)
        public
        view
        returns (bool active, uint256 icr, uint256 threshold, bool below, bool liquidatable)
    {
        threshold = alerts[borrower].threshold;
        active = troveManager.getTroveStatus(borrower) == 1;
        if (!active) return (false, 0, threshold, false, false);
        icr = troveManager.getCurrentICR(borrower, priceFeed.fetchPrice());
        below = threshold != 0 && icr < threshold;
        liquidatable = icr < MCR;
    }

    /// @notice Permissionless: emits AlertTriggered if `borrower` is under their threshold (rate-limited).
    function poke(address borrower) external {
        Alert storage a = alerts[borrower];
        if (a.threshold == 0) revert NoAlert();
        if (a.lastTriggered != 0 && block.timestamp < a.lastTriggered + POKE_COOLDOWN) revert Cooldown();
        if (troveManager.getTroveStatus(borrower) != 1) revert NoActiveTrove();
        uint256 price = priceFeed.fetchPrice();
        uint256 icr = troveManager.getCurrentICR(borrower, price);
        if (icr >= a.threshold) revert NotBelowThreshold();
        a.lastTriggered = uint64(block.timestamp);
        emit AlertTriggered(borrower, icr, a.threshold, price);
    }
}
