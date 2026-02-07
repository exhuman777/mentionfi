// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC6909 } from "@solady/tokens/ERC6909.sol";
import { Ownable } from "@solady/auth/Ownable.sol";

/// @title ReputationToken
/// @notice EIP-6909 multi-token reputation system for MentionFi
/// @dev Token IDs represent different reputation categories:
///      - ID 0: General reputation (REP)
///      - ID 1: Prediction accuracy (ACC)
///      - ID 2: Quest creation (CREATE)
///      - ID 3: Challenge wins (CHAL)
contract ReputationToken is ERC6909, Ownable {
    /*//////////////////////////////////////////////////////////////
                                 CONSTANTS
    //////////////////////////////////////////////////////////////*/

    uint256 public constant REP = 0;
    uint256 public constant ACC = 1;
    uint256 public constant CREATE = 2;
    uint256 public constant CHAL = 3;

    /// @notice Initial reputation given to new agents
    uint256 public constant INITIAL_REP = 100e18;

    /// @notice Decay rate per epoch (1% = 100 basis points)
    uint256 public constant DECAY_RATE_BPS = 100;

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice Authorized minters (MentionQuest contract)
    mapping(address => bool) public minters;

    /// @notice Track registered agents
    mapping(address => bool) public registered;

    /// @notice Last activity epoch per agent
    mapping(address => uint256) public lastActiveEpoch;

    /// @notice Epoch duration in seconds (1 day)
    uint256 public epochDuration = 1 days;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event AgentRegistered(address indexed agent, uint256 initialRep);
    event MinterUpdated(address indexed minter, bool authorized);
    event ReputationDecayed(address indexed agent, uint256 oldRep, uint256 newRep);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotMinter();
    error AlreadyRegistered();
    error NotRegistered();
    error InsufficientReputation();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor() {
        _initializeOwner(msg.sender);
    }

    /*//////////////////////////////////////////////////////////////
                            ERC6909 METADATA
    //////////////////////////////////////////////////////////////*/

    function name(uint256 id) public pure override returns (string memory) {
        if (id == REP) return "MentionFi Reputation";
        if (id == ACC) return "Prediction Accuracy";
        if (id == CREATE) return "Quest Creation";
        if (id == CHAL) return "Challenge Wins";
        return "Unknown";
    }

    function symbol(uint256 id) public pure override returns (string memory) {
        if (id == REP) return "REP";
        if (id == ACC) return "ACC";
        if (id == CREATE) return "CREATE";
        if (id == CHAL) return "CHAL";
        return "???";
    }

    function tokenURI(uint256) public pure override returns (string memory) {
        return "";
    }

    /*//////////////////////////////////////////////////////////////
                           AGENT REGISTRATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Register a new agent with initial reputation
    function register() external {
        if (registered[msg.sender]) revert AlreadyRegistered();

        registered[msg.sender] = true;
        lastActiveEpoch[msg.sender] = currentEpoch();

        _mint(msg.sender, REP, INITIAL_REP);

        emit AgentRegistered(msg.sender, INITIAL_REP);
    }

    /// @notice Check if agent is registered
    function isRegistered(address agent) external view returns (bool) {
        return registered[agent];
    }

    /*//////////////////////////////////////////////////////////////
                          REPUTATION MANAGEMENT
    //////////////////////////////////////////////////////////////*/

    /// @notice Mint reputation (only authorized minters)
    function mint(address to, uint256 id, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        if (!registered[to]) revert NotRegistered();

        _updateActivity(to);
        _mint(to, id, amount);
    }

    /// @notice Burn reputation (stake or penalty)
    function burn(address from, uint256 id, uint256 amount) external {
        if (!minters[msg.sender]) revert NotMinter();
        if (!registered[from]) revert NotRegistered();
        if (balanceOf(from, id) < amount) revert InsufficientReputation();

        _updateActivity(from);
        _burn(from, id, amount);
    }

    /// @notice Transfer reputation between agents
    function transferRep(address to, uint256 id, uint256 amount) external {
        if (!registered[msg.sender]) revert NotRegistered();
        if (!registered[to]) revert NotRegistered();

        _updateActivity(msg.sender);
        _updateActivity(to);

        transfer(to, id, amount);
    }

    /*//////////////////////////////////////////////////////////////
                            DECAY MECHANISM
    //////////////////////////////////////////////////////////////*/

    /// @notice Current epoch number
    function currentEpoch() public view returns (uint256) {
        return block.timestamp / epochDuration;
    }

    /// @notice Apply decay to inactive agents
    function applyDecay(address agent) external {
        if (!registered[agent]) revert NotRegistered();

        uint256 lastEpoch = lastActiveEpoch[agent];
        uint256 current = currentEpoch();

        if (current <= lastEpoch) return;

        uint256 epochsMissed = current - lastEpoch;
        uint256 currentRep = balanceOf(agent, REP);

        // Compound decay: rep * (1 - rate)^epochs
        // Simplified: rep * (10000 - DECAY_RATE_BPS)^epochs / 10000^epochs
        uint256 newRep = currentRep;
        for (uint256 i = 0; i < epochsMissed && i < 100; i++) {
            newRep = (newRep * (10000 - DECAY_RATE_BPS)) / 10000;
        }

        if (newRep < currentRep) {
            uint256 decay = currentRep - newRep;
            _burn(agent, REP, decay);
            emit ReputationDecayed(agent, currentRep, newRep);
        }

        lastActiveEpoch[agent] = current;
    }

    /// @notice Update activity timestamp (internal)
    function _updateActivity(address agent) internal {
        lastActiveEpoch[agent] = currentEpoch();
    }

    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/

    /// @notice Set minter authorization
    function setMinter(address minter, bool authorized) external onlyOwner {
        minters[minter] = authorized;
        emit MinterUpdated(minter, authorized);
    }

    /// @notice Update epoch duration
    function setEpochDuration(uint256 newDuration) external onlyOwner {
        epochDuration = newDuration;
    }
}
