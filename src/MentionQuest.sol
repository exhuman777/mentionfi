// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Ownable } from "@solady/auth/Ownable.sol";
import { ReputationToken } from "./ReputationToken.sol";

/// @title MentionQuest
/// @notice Information prediction market for AI agents
/// @dev Agents stake REP (reputation) + ETH on what mentions will appear in data streams
contract MentionQuest is Ownable {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    enum QuestStatus {
        Open,       // Accepting claims
        Closed,     // Window ended, awaiting resolution
        Resolved,   // Oracle has resolved
        Cancelled   // Quest cancelled (refund stakes)
    }

    enum Position {
        None,
        Yes,
        No
    }

    struct Quest {
        uint256 id;
        address creator;
        bytes32 keywordHash;      // keccak256 of keyword to match
        string sourceUrl;         // RSS/data source URL
        uint64 windowStart;       // When monitoring starts
        uint64 windowEnd;         // When monitoring ends
        uint64 createdAt;
        QuestStatus status;
        Position outcome;         // Final resolution
    }

    struct QuestStakes {
        uint256 totalYesRepStake;
        uint256 totalNoRepStake;
        uint256 totalYesEthStake;
        uint256 totalNoEthStake;
    }

    struct Claim {
        address agent;
        Position position;
        uint256 repStake;         // REP staked
        uint256 ethStake;         // ETH staked
        uint256 confidence;       // 1-100 (percentage)
        bool claimed;             // Rewards claimed
    }

    /*//////////////////////////////////////////////////////////////
                                 STORAGE
    //////////////////////////////////////////////////////////////*/

    ReputationToken public repToken;

    /// @notice Quest ID counter
    uint256 public questCount;

    /// @notice All quests by ID
    mapping(uint256 => Quest) public quests;

    /// @notice Stakes per quest
    mapping(uint256 => QuestStakes) public questStakes;

    /// @notice Claims per quest: questId => agent => Claim
    mapping(uint256 => mapping(address => Claim)) public claims;

    /// @notice Authorized oracles that can resolve quests
    mapping(address => bool) public oracles;

    /// @notice Minimum reputation to create a quest
    uint256 public minRepToCreate = 50e18;

    /// @notice Default REP stake limits
    uint256 public defaultMinRepStake = 10e18;
    uint256 public defaultMaxRepStake = 100e18;

    /// @notice Default ETH stake limits
    uint256 public defaultMinEthStake = 0.001 ether;
    uint256 public defaultMaxEthStake = 1 ether;

    /// @notice Creator reward percentage (basis points)
    uint256 public creatorRewardBps = 500; // 5%

    /// @notice Protocol fee percentage (basis points)
    uint256 public protocolFeeBps = 500; // 5%

    /// @notice Protocol fee recipient
    address public protocolFeeRecipient;

    /// @notice Accumulated protocol fees (ETH)
    uint256 public accumulatedFees;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event QuestCreated(
        uint256 indexed questId,
        address indexed creator,
        bytes32 keywordHash,
        string sourceUrl,
        uint64 windowStart,
        uint64 windowEnd
    );

    event ClaimSubmitted(
        uint256 indexed questId,
        address indexed agent,
        Position position,
        uint256 repStake,
        uint256 ethStake,
        uint256 confidence
    );

    event QuestResolved(
        uint256 indexed questId,
        Position outcome,
        address indexed oracle
    );

    event RewardsClaimed(
        uint256 indexed questId,
        address indexed agent,
        uint256 repReward,
        uint256 ethReward
    );

    event QuestCancelled(uint256 indexed questId);

    event FeesWithdrawn(address indexed recipient, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error NotOracle();
    error QuestNotOpen();
    error QuestNotClosed();
    error QuestNotResolved();
    error InvalidWindow();
    error InsufficientReputation();
    error InvalidStake();
    error AlreadyClaimed();
    error NoClaim();
    error InvalidPosition();
    error WindowNotStarted();
    error WindowEnded();
    error NotCreator();
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTOR
    //////////////////////////////////////////////////////////////*/

    constructor(address _repToken) {
        _initializeOwner(msg.sender);
        repToken = ReputationToken(_repToken);
        protocolFeeRecipient = msg.sender;
    }

    /*//////////////////////////////////////////////////////////////
                            QUEST CREATION
    //////////////////////////////////////////////////////////////*/

    /// @notice Create a new prediction quest
    function createQuest(
        string calldata keyword,
        string calldata sourceUrl,
        uint64 windowStart,
        uint64 windowEnd
    ) external returns (uint256 questId) {
        // Verify agent has enough reputation
        if (repToken.balanceOf(msg.sender, repToken.REP()) < minRepToCreate) {
            revert InsufficientReputation();
        }

        // Validate window
        if (windowEnd <= windowStart) revert InvalidWindow();
        if (windowStart < block.timestamp) revert InvalidWindow();

        questId = ++questCount;

        quests[questId] = Quest({
            id: questId,
            creator: msg.sender,
            keywordHash: keccak256(bytes(keyword)),
            sourceUrl: sourceUrl,
            windowStart: windowStart,
            windowEnd: windowEnd,
            createdAt: uint64(block.timestamp),
            status: QuestStatus.Open,
            outcome: Position.None
        });

        // Reward creator with CREATE reputation
        repToken.mint(msg.sender, repToken.CREATE(), 10e18);

        emit QuestCreated(
            questId,
            msg.sender,
            quests[questId].keywordHash,
            sourceUrl,
            windowStart,
            windowEnd
        );
    }

    /*//////////////////////////////////////////////////////////////
                           CLAIM SUBMISSION
    //////////////////////////////////////////////////////////////*/

    /// @notice Submit a claim on a quest with REP + ETH stake
    /// @dev Send ETH with the transaction for ETH stake
    function submitClaim(
        uint256 questId,
        Position position,
        uint256 repStake,
        uint256 confidence
    ) external payable {
        Quest storage quest = quests[questId];
        QuestStakes storage stakes = questStakes[questId];

        if (quest.status != QuestStatus.Open) revert QuestNotOpen();
        if (block.timestamp < quest.windowStart) revert WindowNotStarted();
        if (block.timestamp >= quest.windowEnd) revert WindowEnded();
        if (position == Position.None) revert InvalidPosition();
        if (confidence == 0 || confidence > 100) revert InvalidStake();

        // Validate REP stake
        if (repStake < defaultMinRepStake || repStake > defaultMaxRepStake) revert InvalidStake();

        // Validate ETH stake
        uint256 ethStake = msg.value;
        if (ethStake < defaultMinEthStake || ethStake > defaultMaxEthStake) revert InvalidStake();

        // Check existing claim
        Claim storage existing = claims[questId][msg.sender];
        if (existing.position != Position.None) revert AlreadyClaimed();

        // Verify and burn REP stake
        if (repToken.balanceOf(msg.sender, repToken.REP()) < repStake) {
            revert InsufficientReputation();
        }
        repToken.burn(msg.sender, repToken.REP(), repStake);

        // Record claim
        claims[questId][msg.sender] = Claim({
            agent: msg.sender,
            position: position,
            repStake: repStake,
            ethStake: ethStake,
            confidence: confidence,
            claimed: false
        });

        // Update totals
        if (position == Position.Yes) {
            stakes.totalYesRepStake += repStake;
            stakes.totalYesEthStake += ethStake;
        } else {
            stakes.totalNoRepStake += repStake;
            stakes.totalNoEthStake += ethStake;
        }

        emit ClaimSubmitted(questId, msg.sender, position, repStake, ethStake, confidence);
    }

    /*//////////////////////////////////////////////////////////////
                              RESOLUTION
    //////////////////////////////////////////////////////////////*/

    /// @notice Close quest for new claims
    function closeQuest(uint256 questId) external {
        Quest storage quest = quests[questId];

        if (quest.status != QuestStatus.Open) revert QuestNotOpen();
        if (block.timestamp < quest.windowEnd) revert WindowNotStarted();

        quest.status = QuestStatus.Closed;
    }

    /// @notice Resolve quest outcome (oracle only)
    function resolveQuest(
        uint256 questId,
        Position outcome,
        bytes32 /* proof */
    ) external {
        if (!oracles[msg.sender]) revert NotOracle();

        Quest storage quest = quests[questId];
        QuestStakes storage stakes = questStakes[questId];

        // Auto-close if still open and window ended
        if (quest.status == QuestStatus.Open && block.timestamp >= quest.windowEnd) {
            quest.status = QuestStatus.Closed;
        }

        if (quest.status != QuestStatus.Closed) revert QuestNotClosed();
        if (outcome == Position.None) revert InvalidPosition();

        quest.status = QuestStatus.Resolved;
        quest.outcome = outcome;

        // Calculate and set aside protocol fees from losing ETH pool
        uint256 losingEthPool = outcome == Position.Yes
            ? stakes.totalNoEthStake
            : stakes.totalYesEthStake;
        uint256 protocolFee = (losingEthPool * protocolFeeBps) / 10000;
        accumulatedFees += protocolFee;

        emit QuestResolved(questId, outcome, msg.sender);
    }

    /// @notice Cancel quest and refund all stakes
    function cancelQuest(uint256 questId) external {
        Quest storage quest = quests[questId];

        if (msg.sender != quest.creator && msg.sender != owner()) {
            revert NotCreator();
        }

        if (quest.status == QuestStatus.Resolved) revert QuestNotOpen();

        quest.status = QuestStatus.Cancelled;

        emit QuestCancelled(questId);
    }

    /*//////////////////////////////////////////////////////////////
                            REWARD CLAIMING
    //////////////////////////////////////////////////////////////*/

    /// @notice Claim rewards after quest resolution
    function claimReward(uint256 questId) external {
        Quest storage quest = quests[questId];
        Claim storage claim = claims[questId][msg.sender];

        if (claim.position == Position.None) revert NoClaim();
        if (claim.claimed) revert AlreadyClaimed();

        claim.claimed = true;

        if (quest.status == QuestStatus.Cancelled) {
            _refundClaim(claim);
            emit RewardsClaimed(questId, msg.sender, claim.repStake, claim.ethStake);
            return;
        }

        if (quest.status != QuestStatus.Resolved) revert QuestNotResolved();

        if (claim.position == quest.outcome) {
            _distributeWinnings(questId, quest, claim);
        }
        // Losers get nothing
    }

    function _refundClaim(Claim storage claim) internal {
        repToken.mint(msg.sender, repToken.REP(), claim.repStake);

        if (claim.ethStake > 0) {
            (bool success,) = msg.sender.call{ value: claim.ethStake }("");
            if (!success) revert TransferFailed();
        }
    }

    function _distributeWinnings(uint256 questId, Quest storage quest, Claim storage claim) internal {
        QuestStakes storage stakes = questStakes[questId];

        // Get pools
        uint256 winningRepPool = quest.outcome == Position.Yes
            ? stakes.totalYesRepStake
            : stakes.totalNoRepStake;
        uint256 losingRepPool = quest.outcome == Position.Yes
            ? stakes.totalNoRepStake
            : stakes.totalYesRepStake;

        uint256 winningEthPool = quest.outcome == Position.Yes
            ? stakes.totalYesEthStake
            : stakes.totalNoEthStake;
        uint256 losingEthPool = quest.outcome == Position.Yes
            ? stakes.totalNoEthStake
            : stakes.totalYesEthStake;

        // Calculate fees
        uint256 protocolFee = (losingEthPool * protocolFeeBps) / 10000;
        uint256 creatorEthCut = (losingEthPool * creatorRewardBps) / 10000;
        uint256 distributableEthPool = losingEthPool - protocolFee - creatorEthCut;

        uint256 creatorRepCut = (losingRepPool * creatorRewardBps) / 10000;
        uint256 distributableRepPool = losingRepPool - creatorRepCut;

        // Calculate rewards
        uint256 repReward = claim.repStake;
        uint256 ethReward = claim.ethStake;

        if (winningRepPool > 0) {
            repReward += (distributableRepPool * claim.repStake) / winningRepPool;
        }

        if (winningEthPool > 0) {
            ethReward += (distributableEthPool * claim.ethStake) / winningEthPool;
        }

        // Accuracy bonus
        uint256 accuracyBonus = (claim.confidence * 1e18) / 10;

        // Distribute REP
        repToken.mint(msg.sender, repToken.REP(), repReward);
        repToken.mint(msg.sender, repToken.ACC(), accuracyBonus);

        if (creatorRepCut > 0) {
            repToken.mint(quest.creator, repToken.REP(), creatorRepCut);
        }

        // Distribute ETH
        if (creatorEthCut > 0) {
            (bool s1,) = quest.creator.call{ value: creatorEthCut }("");
            if (!s1) revert TransferFailed();
        }

        if (ethReward > 0) {
            (bool s2,) = msg.sender.call{ value: ethReward }("");
            if (!s2) revert TransferFailed();
        }

        emit RewardsClaimed(questId, msg.sender, repReward, ethReward);
    }

    /*//////////////////////////////////////////////////////////////
                               VIEWS
    //////////////////////////////////////////////////////////////*/

    function getQuest(uint256 questId) external view returns (Quest memory) {
        return quests[questId];
    }

    function getClaim(uint256 questId, address agent) external view returns (Claim memory) {
        return claims[questId][agent];
    }

    function getStakes(uint256 questId) external view returns (
        uint256 yesRep,
        uint256 noRep,
        uint256 yesEth,
        uint256 noEth
    ) {
        QuestStakes storage s = questStakes[questId];
        return (s.totalYesRepStake, s.totalNoRepStake, s.totalYesEthStake, s.totalNoEthStake);
    }

    function getOdds(uint256 questId) external view returns (uint256 yesOdds, uint256 noOdds) {
        QuestStakes storage s = questStakes[questId];
        uint256 total = s.totalYesEthStake + s.totalNoEthStake;

        if (total == 0) return (50, 50);

        yesOdds = (s.totalYesEthStake * 100) / total;
        noOdds = (s.totalNoEthStake * 100) / total;
    }

    /*//////////////////////////////////////////////////////////////
                               ADMIN
    //////////////////////////////////////////////////////////////*/

    function setOracle(address oracle, bool authorized) external onlyOwner {
        oracles[oracle] = authorized;
    }

    function setMinRepToCreate(uint256 amount) external onlyOwner {
        minRepToCreate = amount;
    }

    function setRepStakeLimits(uint256 minStake, uint256 maxStake) external onlyOwner {
        defaultMinRepStake = minStake;
        defaultMaxRepStake = maxStake;
    }

    function setEthStakeLimits(uint256 minStake, uint256 maxStake) external onlyOwner {
        defaultMinEthStake = minStake;
        defaultMaxEthStake = maxStake;
    }

    function setCreatorRewardBps(uint256 bps) external onlyOwner {
        require(bps <= 2000, "Max 20%");
        creatorRewardBps = bps;
    }

    function setProtocolFeeBps(uint256 bps) external onlyOwner {
        require(bps <= 1000, "Max 10%");
        protocolFeeBps = bps;
    }

    function setProtocolFeeRecipient(address recipient) external onlyOwner {
        protocolFeeRecipient = recipient;
    }

    function withdrawFees() external {
        uint256 amount = accumulatedFees;
        if (amount == 0) return;

        accumulatedFees = 0;

        (bool success,) = protocolFeeRecipient.call{ value: amount }("");
        if (!success) revert TransferFailed();

        emit FeesWithdrawn(protocolFeeRecipient, amount);
    }

    receive() external payable {}
}
