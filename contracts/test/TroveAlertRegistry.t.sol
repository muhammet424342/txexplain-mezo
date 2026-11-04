// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {TroveAlertRegistry} from "../src/TroveAlertRegistry.sol";

interface Vm {
    function prank(address) external;
    function warp(uint256) external;
    function expectRevert(bytes4) external;
    function createSelectFork(string calldata) external returns (uint256);
    function mockCall(address, bytes calldata, bytes calldata) external;
}

contract MockTM {
    mapping(address => uint256) public status;
    mapping(address => uint256) public icr;
    function set(address b, uint256 s, uint256 r) external { status[b] = s; icr[b] = r; }
    function getTroveStatus(address b) external view returns (uint256) { return status[b]; }
    function getCurrentICR(address b, uint256) external view returns (uint256) { return icr[b]; }
}

contract MockPF {
    function fetchPrice() external pure returns (uint256) { return 78_000e18; }
}

contract TroveAlertRegistryTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event AlertTriggered(address indexed borrower, uint256 icr, uint256 threshold, uint256 price);
    MockTM tm;
    TroveAlertRegistry reg;
    address alice = address(0xA11CE);

    function setUp() public {
        tm = new MockTM();
        reg = new TroveAlertRegistry(address(tm), address(new MockPF()));
        tm.set(alice, 1, 1.8e18);
    }

    function test_setAndCheck() public {
        vm.prank(alice);
        reg.setAlert(1.6e18);
        (bool active, uint256 icr, uint256 th, bool below, bool liq) = reg.check(alice);
        require(active && icr == 1.8e18 && th == 1.6e18 && !below && !liq, "check");
        tm.set(alice, 1, 1.5e18);
        (, , , below, liq) = reg.check(alice);
        require(below && !liq, "below");
        tm.set(alice, 1, 1.05e18);
        (, , , below, liq) = reg.check(alice);
        require(below && liq, "liq");
    }

    function test_rejectsBadThreshold() public {
        vm.prank(alice);
        vm.expectRevert(TroveAlertRegistry.ThresholdOutOfRange.selector);
        reg.setAlert(1e18);
    }

    function test_requiresActiveTrove() public {
        vm.prank(address(0xB0B));
        vm.expectRevert(TroveAlertRegistry.NoActiveTrove.selector);
        reg.setAlert(1.6e18);
    }

    function test_pokeFlow() public {
        vm.prank(alice);
        reg.setAlert(1.6e18);
        vm.expectRevert(TroveAlertRegistry.NotBelowThreshold.selector);
        reg.poke(alice);
        tm.set(alice, 1, 1.5e18);
        vm.warp(1_000_000);
        reg.poke(alice);
        (, uint64 last) = reg.alerts(alice);
        require(last == 1_000_000, "ts");
        vm.expectRevert(TroveAlertRegistry.Cooldown.selector);
        reg.poke(alice);
        vm.warp(1_000_000 + 1 hours);
        reg.poke(alice);
    }

    function test_clear() public {
        vm.prank(alice);
        reg.setAlert(1.6e18);
        vm.prank(alice);
        reg.clearAlert();
        (uint128 th, ) = reg.alerts(alice);
        require(th == 0, "cleared");
        vm.expectRevert(TroveAlertRegistry.NoAlert.selector);
        reg.poke(alice);
    }

    /// Read-only fork of Mezo testnet against the official TroveManager/PriceFeed (docs testnet addresses).
    function test_fork_realTrove() public {
        vm.createSelectFork("mezo_testnet");
        TroveAlertRegistry r = new TroveAlertRegistry(
            0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0, 0x86bCF0841622a5dAC14A313a15f96A95421b9366
        );
        // Mezo's oracle precompile (0x7b7c..15) is not emulated by a local fork, so pin the live
        // PriceFeed.fetchPrice() value (cast call on 4 Nov 2026: 78091.22851e18). TroveManager reads stay real.
        vm.mockCall(0x86bCF0841622a5dAC14A313a15f96A95421b9366, abi.encodeWithSignature("fetchPrice()"), abi.encode(uint256(78091228510000000000000)));
        address b = 0xca46BC7646fD202F0E20e0c8CE16093A3C4D33C6;
        vm.prank(b);
        r.setAlert(1.6e18);
        (bool active, uint256 icr, , bool below, ) = r.check(b);
        require(active && icr > 1.1e18, "real trove");
        require(below == (icr < 1.6e18), "below");
    }
}
