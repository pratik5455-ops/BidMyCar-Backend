const express = require("express");
const db = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware");

const router = express.Router();


// =====================================================
// AUCTION STATUS HELPER
// =====================================================

const updateAuctionStatus = async (connection, auction) => {
    const now = new Date();

    const startTime = new Date(auction.start_time);

    const endTime = new Date(
        auction.current_end_time || auction.end_time
    );

    // Safety check
    if (
        Number.isNaN(startTime.getTime()) ||
        Number.isNaN(endTime.getTime())
    ) {
        throw new Error(
            `Invalid auction dates for auction ${auction.id}`
        );
    }

    let newStatus;

    // Auction has not started
    if (now < startTime) {
        newStatus = "upcoming";
    }

    // Auction is currently running
    else if (now < endTime) {
        newStatus = "active";
    }

    // Auction has ended
    else {
        newStatus = "ended";
    }

    // Only update database when status actually changed
    if (auction.status !== newStatus) {
        await connection.query(
            `
            UPDATE auctions
            SET status = ?
            WHERE id = ?
            `,
            [
                newStatus,
                auction.id
            ]
        );

        auction.status = newStatus;
    }

    return auction;
};
// =====================================================
// FINALIZE AUCTION + SETTLE PAYMENT
// =====================================================
const finalizeAuction = async (connection, auction) => {

    const now = new Date();

    // -------------------------------------------------
    // 1. DETERMINE ACTUAL END TIME
    // -------------------------------------------------

    const endTime = new Date(
        auction.current_end_time || auction.end_time
    );

    if (Number.isNaN(endTime.getTime())) {
        throw new Error("Invalid auction end time");
    }

    // Auction has not ended yet
    if (now < endTime) {

        return {
            finalized: false,
            settled: false,
            winner: null
        };
    }

    // -------------------------------------------------
    // 2. MAKE SURE AUCTION IS ENDED
    // -------------------------------------------------

    if (auction.status !== "ended") {

        await connection.query(
            `UPDATE auctions
             SET status = 'ended'
             WHERE id = ?`,
            [auction.id]
        );

        auction.status = "ended";
    }

    // -------------------------------------------------
    // 3. ALREADY COMPLETED
    // -------------------------------------------------

    if (auction.settlement_status === "completed") {

        return {
            finalized: true,
            settled: true,

            winner:
                auction.reserve_met &&
                auction.high_bidder_id
                    ? {
                        bidder_id: Number(
                            auction.high_bidder_id
                        ),
                        bidder_name:
                            auction.high_bidder
                    }
                    : null
        };
    }

    // -------------------------------------------------
    // 4. ALREADY MARKED AS NO WINNER
    // -------------------------------------------------

    if (auction.settlement_status === "no_winner") {

        return {
            finalized: true,
            settled: true,
            winner: null
        };
    }

    // -------------------------------------------------
    // 5. VALIDATE WINNER
    // -------------------------------------------------

    const reserveMet =
        Number(auction.reserve_met) === 1;

    const highBidderId =
        auction.high_bidder_id
            ? Number(auction.high_bidder_id)
            : null;

    // No valid winner
    if (!reserveMet || !highBidderId) {

        await connection.query(
            `UPDATE auctions
             SET
                settlement_status = 'no_winner',
                settled_at = NOW(),
                settlement_reference = ?
             WHERE id = ?
               AND settlement_status = 'pending'`,
            [
                `NO_WINNER-${auction.id}`,
                auction.id
            ]
        );

        auction.settlement_status = "no_winner";
        auction.settled_at = new Date();
        auction.settlement_reference =
            `NO_WINNER-${auction.id}`;

        return {
            finalized: true,
            settled: true,
            winner: null
        };
    }

    // -------------------------------------------------
    // 6. VALIDATE SELLER
    // -------------------------------------------------

    const sellerId = Number(auction.seller_id);

    if (!Number.isInteger(sellerId)) {

        throw new Error(
            "Invalid seller ID for auction settlement"
        );
    }

    // -------------------------------------------------
    // 7. VALIDATE FINAL PRICE
    // -------------------------------------------------

    const finalPrice =
        Number(auction.current_bid);

    if (
        !Number.isFinite(finalPrice) ||
        finalPrice <= 0
    ) {

        throw new Error(
            "Invalid final auction price"
        );
    }

    // -------------------------------------------------
    // 8. CHECK EXISTING PURCHASE
    // -------------------------------------------------

    const [existingPurchases] =
        await connection.query(
            `SELECT
                id,
                buyer_id,
                purchase_price,
                status
             FROM vehicle_purchases
             WHERE vehicle_id = ?
             LIMIT 1
             FOR UPDATE`,
            [auction.vehicle_id]
        );

    if (existingPurchases.length > 0) {

        const existingPurchase =
            existingPurchases[0];

        // Existing purchase belongs to this winner
        if (
            Number(existingPurchase.buyer_id) ===
            highBidderId
        ) {

            const reference =
                `SETTLED-${auction.id}`;

            await connection.query(
                `UPDATE auctions
                 SET
                    settlement_status = 'completed',
                    settled_at = COALESCE(
                        settled_at,
                        NOW()
                    ),
                    settlement_reference = COALESCE(
                        settlement_reference,
                        ?
                    )
                 WHERE id = ?`,
                [
                    reference,
                    auction.id
                ]
            );

            auction.settlement_status =
                "completed";

            auction.settlement_reference =
                reference;

            return {
                finalized: true,
                settled: true,

                winner: {
                    bidder_id: highBidderId,
                    bidder_name:
                        auction.high_bidder
                }
            };
        }

        // Vehicle is already owned by someone else
        throw new Error(
            "Vehicle has already been purchased by another buyer"
        );
    }

    // -------------------------------------------------
    // 9. LOCK BUYER + SELLER
    // -------------------------------------------------

    const [users] =
        await connection.query(
            `SELECT
                id,
                wallet_balance
             FROM users
             WHERE id IN (?, ?)
             ORDER BY id
             FOR UPDATE`,
            [
                highBidderId,
                sellerId
            ]
        );

    const winner =
        users.find(
            user =>
                Number(user.id) ===
                highBidderId
        );

    const seller =
        users.find(
            user =>
                Number(user.id) ===
                sellerId
        );

    if (!winner) {

        throw new Error(
            "Auction winner account not found"
        );
    }

    if (!seller) {

        throw new Error(
            "Vehicle seller account not found"
        );
    }

    // -------------------------------------------------
    // 10. CHECK BUYER BALANCE
    // -------------------------------------------------

    const winnerBalance =
        Number(winner.wallet_balance);

    if (
    !Number.isFinite(winnerBalance) ||
    winnerBalance < finalPrice
) {

    const paymentDeadline =
        await createPaymentDeadline(
            connection,
            auction
        );

    return {
        finalized: true,
        settled: false,

        winner: {
            bidder_id: highBidderId,
            bidder_name:
                auction.high_bidder
        },

        payment_required: true,
        payment_failed: true,

        payment_deadline:
            paymentDeadline,

        message:
            "Auction winner does not have sufficient wallet balance"
    };
}
    // -------------------------------------------------
    // 11. CREATE UNIQUE SETTLEMENT REFERENCE
    // -------------------------------------------------

    const settlementReference =
        `SETTLEMENT-${auction.id}`;

    // -------------------------------------------------
    // 12. MARK PROCESSING
    // -------------------------------------------------

    await connection.query(
        `UPDATE auctions
         SET settlement_status = 'processing'
         WHERE id = ?
           AND settlement_status = 'pending'`,
        [auction.id]
    );

    // -------------------------------------------------
    // 13. DEBIT WINNER
    // -------------------------------------------------

    const [debitResult] =
        await connection.query(
            `UPDATE users
             SET wallet_balance =
                 wallet_balance - ?
             WHERE id = ?
               AND wallet_balance >= ?`,
            [
                finalPrice,
                highBidderId,
                finalPrice
            ]
        );

    if (debitResult.affectedRows !== 1) {

        throw new Error(
            "Winner wallet debit failed"
        );
    }

    // -------------------------------------------------
    // 14. RECORD BUYER DEBIT
    // -------------------------------------------------

    await connection.query(
        `INSERT INTO wallet_transactions
        (
            user_id,
            type,
            amount,
            description,
            reference_id
        )
        VALUES (?, 'debit', ?, ?, ?)`,
        [
            highBidderId,
            finalPrice,
            `Payment for vehicle ${auction.vehicle_id}`,
            settlementReference
        ]
    );

    // -------------------------------------------------
    // 15. CREDIT SELLER
    // -------------------------------------------------

    await connection.query(
        `UPDATE users
         SET wallet_balance =
             wallet_balance + ?
         WHERE id = ?`,
        [
            finalPrice,
            sellerId
        ]
    );

    // -------------------------------------------------
    // 16. RECORD SELLER CREDIT
    // -------------------------------------------------

    await connection.query(
        `INSERT INTO wallet_transactions
        (
            user_id,
            type,
            amount,
            description,
            reference_id
        )
        VALUES (?, 'credit', ?, ?, ?)`,
        [
            sellerId,
            finalPrice,
            `Payment received for vehicle ${auction.vehicle_id}`,
            settlementReference
        ]
    );

    // -------------------------------------------------
    // 17. CREATE VEHICLE PURCHASE
    // -------------------------------------------------

    await connection.query(
        `INSERT INTO vehicle_purchases
        (
            vehicle_id,
            buyer_id,
            purchase_price,
            status
        )
        VALUES (?, ?, ?, 'completed')`,
        [
            auction.vehicle_id,
            highBidderId,
            finalPrice
        ]
    );

    // -------------------------------------------------
    // 18. COMPLETE AUCTION SETTLEMENT
    // -------------------------------------------------

    await connection.query(
        `UPDATE auctions
         SET
            settlement_status = 'completed',
            settled_at = NOW(),
            settlement_reference = ?
         WHERE id = ?`,
        [
            settlementReference,
            auction.id
        ]
    );

    // Keep in-memory object synchronized
    auction.settlement_status =
        "completed";

    auction.settled_at =
        new Date();

    auction.settlement_reference =
        settlementReference;

    // -------------------------------------------------
    // 19. RETURN SUCCESS
    // -------------------------------------------------

    return {
        finalized: true,
        settled: true,

        winner: {
            bidder_id: highBidderId,
            bidder_name:
                auction.high_bidder
        },

        payment: {
            amount: finalPrice,
            status: "completed",
            reference:
                settlementReference
        }
    };
};
// =====================================================
// PAYMENT WINDOW
// =====================================================

const PAYMENT_WINDOW_MINUTES = 30;


// -----------------------------------------------------
// CREATE PAYMENT DEADLINE
// -----------------------------------------------------

const createPaymentDeadline = async (
    connection,
    auction
) => {

    // Already has a payment deadline
    if (auction.payment_deadline) {

        return new Date(
            auction.payment_deadline
        );
    }

    const deadline = new Date(
        Date.now() +
        PAYMENT_WINDOW_MINUTES * 60 * 1000
    );

    await connection.query(
        `UPDATE auctions
         SET payment_deadline = ?
         WHERE id = ?
           AND settlement_status = 'pending'`,
        [
            deadline,
            auction.id
        ]
    );

    auction.payment_deadline = deadline;

    return deadline;
};
// =====================================================
// GET MY BIDS
// =====================================================
router.get("/my-bids", authenticateToken, async (req, res) => {
    try {
        const bidderId = req.user.userId;

        const [bids] = await db.query(
            `SELECT
                b.id AS bid_id,
                b.auction_id,
                b.vehicle_id,
                b.bid_amount,
                b.bid_time,

                a.start_time,
                a.end_time,
                a.scheduled_end_time,
                a.current_end_time,
                a.starting_bid,
                a.current_bid,
                a.reserve_price,
                a.reserve_met,
                a.bid_count,
                a.status,
                a.high_bidder,
                a.high_bidder_id,
                a.settlement_status,

                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.seller_id

             FROM bids b

             INNER JOIN auctions a
                 ON b.auction_id = a.id

             INNER JOIN vehicles v
                 ON b.vehicle_id = v.id

             WHERE b.bidder_id = ?

             ORDER BY b.bid_time DESC`,
            [bidderId]
        );

        
        // =====================================================
       // UPDATE / FINALIZE UNIQUE AUCTIONS
      // =====================================================

const processedAuctions = new Set();

for (const bid of bids) {

    const auctionId = Number(
        bid.auction_id
    );

    // Prevent processing the same auction
    // multiple times when the user placed
    // multiple bids on it.
    if (
        processedAuctions.has(auctionId)
    ) {
        continue;
    }

    processedAuctions.add(auctionId);

    const connection =
        await db.getConnection();

    try {

        await connection.beginTransaction();

        // Update lifecycle status
        await updateAuctionStatus(
            connection,
            bid
        );

        // Finalize only if auction has ended
        await finalizeAuction(
            connection,
            bid
        );

        await connection.commit();

    } catch (error) {

        await connection.rollback();

        console.error(
            `Auction ${auctionId} finalization error:`,
            error
        );

        // IMPORTANT:
        // Do not crash the entire /my-bids
        // request because one auction failed.
        //
        // The user's other bids should still
        // be returned.
        continue;

    } finally {

        connection.release();
    }
}

        // Format each bid record according to the auction lifecycle.
        const formattedBids = bids.map(formatAuctionResponse);

        res.status(200).json({
            success: true,
            count: formattedBids.length,
            bids: formattedBids
        });

    } catch (error) {
        console.error("Get my bids error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch your bids"
        });
    }
});
// =====================================================
// GET MY WON / LOST AUCTIONS
// GET /api/auctions/my-results
// =====================================================

router.get("/my-results", authenticateToken, async (req, res) => {
    try {
        const bidderId = req.user.userId;

        const [results] = await db.query(
            `SELECT
                a.id AS auction_id,
                a.vehicle_id,
                a.start_time,
                a.end_time,
                a.starting_bid,
                a.current_bid AS final_bid,
                a.reserve_price,
                a.reserve_met,
                a.bid_count,
                a.status,
                a.high_bidder,
                a.high_bidder_id,
                a.settlement_status,

                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,

                MAX(b.bid_amount) AS my_highest_bid

             FROM bids b

             INNER JOIN auctions a
                 ON b.auction_id = a.id

             INNER JOIN vehicles v
                 ON a.vehicle_id = v.id

             WHERE b.bidder_id = ?
               AND a.status = 'ended'

             GROUP BY
                a.id,
                a.vehicle_id,
                a.start_time,
                a.end_time,
                a.starting_bid,
                a.current_bid,
                a.reserve_price,
                a.reserve_met,
                a.bid_count,
                a.status,
                a.high_bidder,
                a.high_bidder_id,
                a.settlement_status,
                v.title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage

             ORDER BY a.end_time DESC`,
            [bidderId]
        );

        const formattedResults = results.map((auction) => ({
            auction_id: auction.auction_id,
            vehicle_id: auction.vehicle_id,

            vehicle: {
                title: auction.vehicle_title,
                make: auction.make,
                model: auction.model,
                year: auction.year,
                category: auction.category,
                primary_damage: auction.primary_damage
            },

            auction: {
                start_time: auction.start_time,
                end_time: auction.end_time,
                starting_bid: auction.starting_bid,
                final_bid: auction.final_bid,
                reserve_price: auction.reserve_price,
                reserve_met: auction.reserve_met,
                bid_count: auction.bid_count,
                status: auction.status,
                settlement_status: auction.settlement_status
            },

            my_highest_bid: auction.my_highest_bid,

            result:
                auction.high_bidder_id === bidderId &&
                auction.reserve_met === 1
                    ? "WON"
                    : "LOST"
        }));

res.status(200).json({
    success: true,
    count: formattedResults.length,
    results: formattedResults
});

    } catch (error) {
        console.error("Get my auction results error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch your auction results"
        });
    }
});
// =====================================================
// GET MY AUCTIONS (SELLER)
// =====================================================

router.get("/my-auctions", authenticateToken, async (req, res) => {
    try {
        const sellerId = Number(req.user.userId);

        // -------------------------------------------------
        // 1. Validate authenticated user
        // -------------------------------------------------

        if (!Number.isInteger(sellerId) || sellerId <= 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid authenticated user"
            });
        }

        // -------------------------------------------------
        // 2. Get seller's auctions
        // -------------------------------------------------

        const [auctions] = await db.query(
            `
            SELECT
                a.id,
                a.vehicle_id,

                a.start_time,
                a.end_time,
                a.scheduled_end_time,
                a.current_end_time,

                a.extension_seconds,
                a.max_extension_seconds,

                a.starting_bid,
                a.current_bid,
                a.reserve_price,
                a.reserve_met,

                a.bid_count,
                a.status,

                a.high_bidder,
                a.high_bidder_id,

                a.created_at,
                a.updated_at,

                a.settlement_status,
                a.settled_at,
                a.settlement_reference,

                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.secondary_damage,
                v.current_bid AS vehicle_current_bid,
                v.seller_id

            FROM auctions a

            INNER JOIN vehicles v
                ON a.vehicle_id = v.id

            WHERE v.seller_id = ?

            ORDER BY a.start_time DESC
            `,
            [sellerId]
        );

        // -------------------------------------------------
        // 3. Update DISPLAY status only
        //
        // IMPORTANT:
        // This does NOT perform settlement.
        // -------------------------------------------------

        const now = new Date();

        for (const auction of auctions) {

            const startTime = new Date(auction.start_time);

            const endTime = new Date(
                auction.current_end_time ||
                auction.end_time
            );

            // ---------------------------------------------
            // Safety check for invalid database dates
            // ---------------------------------------------

            if (
                Number.isNaN(startTime.getTime()) ||
                Number.isNaN(endTime.getTime())
            ) {
                console.error(
                    `Invalid auction dates for auction ${auction.id}`
                );

                continue;
            }

            // ---------------------------------------------
            // Calculate current lifecycle state
            // ---------------------------------------------

            if (now < startTime) {

                auction.status = "upcoming";

            } else if (now < endTime) {

                auction.status = "active";

            } else {

                auction.status = "ended";
            }
        }

        // -------------------------------------------------
        // 4. Format response
        // -------------------------------------------------

        const formattedAuctions =
            auctions.map(formatAuctionResponse);

        // -------------------------------------------------
        // 5. Send response
        // -------------------------------------------------

        return res.status(200).json({
            success: true,
            count: formattedAuctions.length,
            auctions: formattedAuctions
        });

    } catch (error) {

        console.error(
            "Get my auctions error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Failed to fetch your auctions"
        });
    }
});
// GET MY AUCTION DETAILS (seller)
router.get("/my-auctions/:auctionId", authenticateToken, async (req, res) => {
    try {
        const sellerId = req.user.userId;
        const auctionId = req.params.auctionId;

        const [auctions] = await db.query(
            `SELECT
                a.*,
                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.secondary_damage,
                v.seller_id
             FROM auctions a
             INNER JOIN vehicles v
                ON a.vehicle_id = v.id
             WHERE a.id = ?
               AND v.seller_id = ?`,
            [auctionId, sellerId]
        );

        if (auctions.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Auction not found or you do not own this auction"
            });
        }

        const auction = auctions[0];

let finalization;

const connection = await db.getConnection();

try {

    await connection.beginTransaction();

    // Update auction status according to its time
    await updateAuctionStatus(connection, auction);

    // Finalize auction if its end time has passed
    finalization = await finalizeAuction(
        connection,
        auction
    );

    await connection.commit();

} catch (error) {

    await connection.rollback();

    throw error;

} finally {

    connection.release();
}
        // Get bid history
        const [bids] = await db.query(
            `SELECT
                b.id AS bid_id,
                b.bidder_id,
                b.bidder_name,
                b.bid_amount,
                b.bid_time
             FROM bids b
             WHERE b.auction_id = ?
             ORDER BY b.bid_time DESC`,
            [auctionId]
        );

        // Format auction summary according to lifecycle state
        const formattedAuction = formatAuctionResponse(auction);

        res.status(200).json({
            success: true,
            auction: formattedAuction,
            winner: finalization.winner,
            bids: bids
        });

    } catch (error) {
        console.error("Get seller auction details error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch auction details"
        });
    }
});
// CANCEL AUCTION (seller)
router.delete("/:auctionId", authenticateToken, async (req, res) => {
    const connection = await db.getConnection();

    try {
        const sellerId = req.user.userId;
        const auctionId = req.params.auctionId;

        // Get the auction and verify seller ownership
        const [auctions] = await connection.query(
            `SELECT
                a.id,
                a.vehicle_id,
                a.status,
                a.start_time,
                a.end_time,
                v.seller_id
             FROM auctions a
             INNER JOIN vehicles v
                 ON a.vehicle_id = v.id
             WHERE a.id = ?
               AND v.seller_id = ?`,
            [auctionId, sellerId]
        );

        if (auctions.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Auction not found or you are not the seller"
            });
        }

        const auction = auctions[0];

        // Auction must be upcoming
        if (auction.status !== "upcoming") {
            return res.status(400).json({
                success: false,
                message: "Only upcoming auctions can be cancelled"
            });
        }

        // Check whether any bids exist
        const [bids] = await connection.query(
            `SELECT id
             FROM bids
             WHERE auction_id = ?
             LIMIT 1`,
            [auctionId]
        );

        if (bids.length > 0) {
            return res.status(400).json({
                success: false,
                message: "This auction cannot be cancelled because bids already exist"
            });
        }

        // Delete the auction
        await connection.query(
            `DELETE FROM auctions
             WHERE id = ?`,
            [auctionId]
        );

        res.status(200).json({
            success: true,
            message: "Auction cancelled successfully"
        });

    } catch (error) {
        console.error("Cancel auction error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to cancel auction"
        });

    } finally {
        connection.release();
    }
});
// =====================================================
// GET SINGLE AUCTION
// =====================================================

router.get("/:auctionId", async (req, res) => {
    try {
        const auctionId = req.params.auctionId;

        const [auctions] = await db.query(
            `SELECT
                a.*,
                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.secondary_damage,
                v.current_bid AS vehicle_current_bid,
                v.seller_id
             FROM auctions a
             INNER JOIN vehicles v
                 ON a.vehicle_id = v.id
             WHERE a.id = ?`,
            [auctionId]
        );

        if (auctions.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Auction not found"
            });
        }

     const auction = auctions[0];

let finalization;

const connection = await db.getConnection();

try {

    await connection.beginTransaction();

    await updateAuctionStatus(
        connection,
        auction
    );

    finalization = await finalizeAuction(
        connection,
        auction
    );

    await connection.commit();

} catch (error) {

    await connection.rollback();

    throw error;

} finally {

    connection.release();
}

const formattedAuction =
    formatAuctionResponse(auction); 
res.status(200).json({
    success: true,
    auction: formattedAuction,
    winner: finalization.winner
});

    } catch (error) {
        console.error("Get single auction error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch auction"
        });
    }
});


// =====================================================
// GET AUCTION BID HISTORY
// =====================================================

router.get("/:auctionId/bids", async (req, res) => {
    try {
        const auctionId = req.params.auctionId;

        const [auctions] = await db.query(
            `SELECT id
             FROM auctions
             WHERE id = ?`,
            [auctionId]
        );

        if (auctions.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Auction not found"
            });
        }

        const [bids] = await db.query(
            `SELECT
                id,
                auction_id,
                vehicle_id,
                bidder_name,
                bid_amount,
                bid_time
             FROM bids
             WHERE auction_id = ?
             ORDER BY bid_time DESC`,
            [auctionId]
        );

        res.status(200).json({
            success: true,
            count: bids.length,
            bids: bids
        });

    } catch (error) {
        console.error("Get auction bids error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch bid history"
        });
    }
});
// =====================================================
// CREATE AUCTION
// =====================================================

router.post("/", authenticateToken, async (req, res) => {
    try {
        const sellerId = req.user.userId;

        const {
            vehicle_id,
            start_time,
            end_time,
            starting_bid
        } = req.body;

        // 1. Required fields
        if (
            !vehicle_id ||
            !start_time ||
            !end_time ||
            starting_bid === undefined
        ) {
            return res.status(400).json({
                success: false,
                message: "Vehicle ID, start time, end time and starting bid are required"
            });
        }

        // 2. Validate starting bid
        const startingBid = Number(starting_bid);

        if (
            !Number.isFinite(startingBid) ||
            startingBid <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Starting bid must be a valid positive number"
            });
        }

        // 3. Validate auction dates
        const startDate = new Date(start_time);
        const endDate = new Date(end_time);
        const now = new Date();

        if (
            Number.isNaN(startDate.getTime()) ||
            Number.isNaN(endDate.getTime())
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid start time or end time"
            });
        }

        // Start time must be in the future
        if (startDate <= now) {
            return res.status(400).json({
                success: false,
                message: "Auction start time must be in the future"
            });
        }

        // End time must be after start time
        if (endDate <= startDate) {
            return res.status(400).json({
                success: false,
                message: "Auction end time must be after start time"
            });
        }

        // End time must also be in the future
        if (endDate <= now) {
            return res.status(400).json({
                success: false,
                message: "Auction end time must be in the future"
            });
        }

        // 4. Verify vehicle belongs to seller
        const [vehicles] = await db.query(
            `SELECT id, reserve_price
             FROM vehicles
             WHERE id = ? AND seller_id = ?`,
            [vehicle_id, sellerId]
        );

        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message:
                    "Vehicle not found or you are not authorized to create an auction for it"
            });
        }

        const reservePrice = Number(vehicles[0].reserve_price || 0);

        // 5. Starting bid cannot be greater than reserve price
        if (reservePrice > 0 && startingBid > reservePrice) {
            return res.status(400).json({
                success: false,
                message:
                    "Starting bid cannot be greater than the reserve price"
            });
        }

        // 6. Check whether an auction already exists
        const [existingAuctions] = await db.query(
            `SELECT id
             FROM auctions
             WHERE vehicle_id = ?
             LIMIT 1`,
            [vehicle_id]
        );

        if (existingAuctions.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An auction already exists for this vehicle"
            });
        }

        // 7. Create scheduled auction
        const [result] = await db.query(
            `INSERT INTO auctions
            (
                vehicle_id,
                start_time,
                end_time,
                scheduled_end_time,
                current_end_time,
                extension_seconds,
                max_extension_seconds,
                starting_bid,
                current_bid,
                reserve_price,
                bid_count,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                vehicle_id,
                start_time,
                end_time,
                end_time,
                end_time,
                120,
                1800,
                startingBid,
                0,
                reservePrice,
                0,
                "upcoming"
            ]
        );

        // 8. Get created auction
        const [auctions] = await db.query(
            `SELECT *
             FROM auctions
             WHERE id = ?`,
            [result.insertId]
        );

        res.status(201).json({
            success: true,
            message: "Auction scheduled successfully",
            auction: auctions[0]
        });

    } catch (error) {
        console.error("Create auction error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create auction"
        });
    }
});
// =====================================================
// PLACE BID
// =====================================================

router.post("/:auctionId/bids", authenticateToken, async (req, res) => {
    let connection;

    try {
        const auctionId = req.params.auctionId;
        const bidderId = req.user.userId;
        const { bid_amount } = req.body;

        const bidAmount = Number(bid_amount);

        // 1. Validate bid amount
        if (
            bid_amount === undefined ||
            bid_amount === null ||
            bid_amount === ""
        ) {
            return res.status(400).json({
                success: false,
                message: "Bid amount is required"
            });
        }

        if (
            !Number.isFinite(bidAmount) ||
            bidAmount <= 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Bid amount must be a valid positive number"
            });
        }

        connection = await db.getConnection();

        await connection.beginTransaction();

        // 2. Lock auction row
        const [auctions] = await connection.query(
            `SELECT
                a.*,
                v.seller_id,
                v.sale_status
             FROM auctions a
             INNER JOIN vehicles v
                 ON a.vehicle_id = v.id
             WHERE a.id = ?
             FOR UPDATE`,
            [auctionId]
        );

        if (auctions.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Auction not found"
            });
        }

 const auction = auctions[0];

// Vehicle must still be available for bidding
if (auction.sale_status === "sold") {
    await connection.rollback();

    return res.status(409).json({
        success: false,
        message: "This vehicle has already been sold"
    });
}

// Auction has already reached a final settlement state
if (
    auction.settlement_status === "completed" ||
    auction.settlement_status === "no_winner" ||
    auction.settlement_status === "payment_expired"
) {
    await connection.rollback();

    return res.status(409).json({
        success: false,
        message: "This auction is no longer available for bidding"
    });
}

// 3. Automatically update auction status
await updateAuctionStatus(connection, auction);

        // 3. Automatically update auction status
        await updateAuctionStatus(connection, auction);

        // 4. Check whether bidding is currently allowed
        if (auction.status !== "active") {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message:
                    auction.status === "upcoming"
                        ? "Bidding has not started yet"
                        : "This auction has ended"
            });
        }

        const now = new Date();

        const startTime = new Date(auction.start_time);

        // IMPORTANT:
        // Use current_end_time because it can change
        // when the auction is extended.
        const currentEndTime = new Date(
            auction.current_end_time || auction.end_time
        );

        if (now < startTime || now >= currentEndTime) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                message: "This auction is outside its bidding time"
            });
        }

        // 5. Seller cannot bid on their own vehicle
        if (Number(auction.seller_id) === Number(bidderId)) {
            await connection.rollback();

            return res.status(403).json({
                success: false,
                message: "You cannot bid on your own vehicle"
            });
        }

        // 6. Calculate minimum allowed bid
        const currentBid = Number(auction.current_bid || 0);
        const startingBid = Number(auction.starting_bid || 0);

        const minimumIncrement = 1000;

        const minimumBid =
            currentBid > 0
                ? currentBid + minimumIncrement
                : startingBid;

        if (bidAmount < minimumBid) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: `Your bid must be at least ₹${minimumBid}`
            });
        }

        // 7. Get bidder information
        const [users] = await connection.query(
            `SELECT name
             FROM users
             WHERE id = ?`,
            [bidderId]
        );

        if (users.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Bidder account not found"
            });
        }

        const bidderName = users[0].name;

        // 8. Check reserve price
        const reservePrice = Number(
            auction.reserve_price || 0
        );

        const reserveMet =
            reservePrice > 0 && bidAmount >= reservePrice
                ? 1
                : 0;

        // =====================================================
        // 9. COPART-STYLE SOFT CLOSE
        // =====================================================

        const extensionSeconds = Number(
            auction.extension_seconds || 120
        );

        const maxExtensionSeconds = Number(
            auction.max_extension_seconds || 1800
        );

        const scheduledEndTime = new Date(
            auction.scheduled_end_time || auction.end_time
        );

        const remainingMilliseconds =
            currentEndTime.getTime() - now.getTime();

        const softCloseWindowMilliseconds =
            extensionSeconds * 1000;

        let newEndTime = currentEndTime;
        let auctionExtended = false;

        // Bid was placed during the final 2 minutes
        if (
            remainingMilliseconds > 0 &&
            remainingMilliseconds <= softCloseWindowMilliseconds
        ) {
            const maximumAllowedEndTime = new Date(
                scheduledEndTime.getTime() +
                maxExtensionSeconds * 1000
            );

            const proposedEndTime = new Date(
                currentEndTime.getTime() +
                extensionSeconds * 1000
            );

            if (proposedEndTime <= maximumAllowedEndTime) {
                newEndTime = proposedEndTime;
            } else {
                newEndTime = maximumAllowedEndTime;
            }

            if (
                newEndTime.getTime() >
                currentEndTime.getTime()
            ) {
                auctionExtended = true;

                await connection.query(
                    `UPDATE auctions
                     SET current_end_time = ?
                     WHERE id = ?`,
                    [
                        newEndTime,
                        auctionId
                    ]
                );

                auction.current_end_time = newEndTime;
            }
        }

        // 10. Save bid
        await connection.query(
            `INSERT INTO bids
            (
                auction_id,
                vehicle_id,
                bidder_id,
                bidder_name,
                bid_amount
            )
            VALUES (?, ?, ?, ?, ?)`,
            [
                auctionId,
                auction.vehicle_id,
                bidderId,
                bidderName,
                bidAmount
            ]
        );

        // 11. Update auction
        await connection.query(
            `UPDATE auctions
             SET
                current_bid = ?,
                bid_count = bid_count + 1,
                high_bidder = ?,
                high_bidder_id = ?,
                reserve_met = ?
             WHERE id = ?`,
            [
                bidAmount,
                bidderName,
                bidderId,
                reserveMet,
                auctionId
            ]
        );

        // 12. Update vehicle
        await connection.query(
            `UPDATE vehicles
             SET
                current_bid = ?,
                bid_count = bid_count + 1
             WHERE id = ?`,
            [
                bidAmount,
                auction.vehicle_id
            ]
        );

        await connection.commit();

        // 13. Response
        res.status(201).json({
            success: true,
            message: auctionExtended
                ? "Bid placed successfully. Auction extended by 2 minutes."
                : "Bid placed successfully",

            bid: {
                auction_id: Number(auctionId),
                vehicle_id: auction.vehicle_id,
                bidder_name: bidderName,
                bid_amount: bidAmount
            },

            auction: {
                current_bid: bidAmount,
                bid_count: Number(auction.bid_count) + 1,
                high_bidder: bidderName,
                current_end_time: newEndTime,
                auction_extended: auctionExtended
            }
        });

    } catch (error) {

        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    "Rollback error:",
                    rollbackError
                );
            }
        }

        console.error(
            "Place bid error:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Failed to place bid"
        });

    } finally {

        if (connection) {
            connection.release();
        }
    }
});
// =====================================================
// PAY FOR WON AUCTION
// POST /api/auctions/:auctionId/pay
// =====================================================

router.post(
    "/:auctionId/pay",
    authenticateToken,
    async (req, res) => {

        let connection;

        try {

            const auctionId =
                Number(req.params.auctionId);

            const bidderId =
                Number(req.user.userId);

            if (!Number.isInteger(auctionId)) {

                return res.status(400).json({
                    success: false,
                    message: "Invalid auction ID"
                });
            }

            connection =
                await db.getConnection();

            await connection.beginTransaction();

            // -------------------------------------------------
            // 1. LOCK AUCTION
            // -------------------------------------------------

            const [auctions] =
                await connection.query(
                    `SELECT
                        a.*,
                        v.seller_id
                     FROM auctions a
                     INNER JOIN vehicles v
                        ON a.vehicle_id = v.id
                     WHERE a.id = ?
                     FOR UPDATE`,
                    [auctionId]
                );

            if (auctions.length === 0) {

                await connection.rollback();

                return res.status(404).json({
                    success: false,
                    message: "Auction not found"
                });
            }

            const auction =
                auctions[0];

            // -------------------------------------------------
            // 2. CHECK AUCTION STATUS
            // -------------------------------------------------

            if (auction.status !== "ended") {

                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message:
                        "This auction has not ended yet"
                });
            }

            // -------------------------------------------------
            // 3. CHECK SETTLEMENT STATUS
            // -------------------------------------------------

            if (
                auction.settlement_status ===
                "completed"
            ) {

                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message:
                        "This auction has already been paid"
                });
            }

            // -------------------------------------------------
            // 4. CHECK WINNER
            // -------------------------------------------------

            if (
                Number(auction.high_bidder_id) !==
                bidderId
            ) {

                await connection.rollback();

                return res.status(403).json({
                    success: false,
                    message:
                        "You are not the winner of this auction"
                });
            }

            // -------------------------------------------------
            // 5. CHECK RESERVE
            // -------------------------------------------------

            if (
                Number(auction.reserve_met) !==
                1
            ) {

                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message:
                        "Reserve price was not met"
                });
            }

            // -------------------------------------------------
            // 6. VALIDATE FINAL PRICE
            // -------------------------------------------------

            const finalPrice =
                Number(auction.current_bid);

            if (
                !Number.isFinite(finalPrice) ||
                finalPrice <= 0
            ) {

                await connection.rollback();

                return res.status(500).json({
                    success: false,
                    message:
                        "Invalid auction final price"
                });
            }

            // -------------------------------------------------
            // 7. CHECK PAYMENT DEADLINE
            // -------------------------------------------------

            if (auction.payment_deadline) {

                const paymentDeadline =
                    new Date(
                        auction.payment_deadline
                    );

                if (
                    Number.isNaN(
                        paymentDeadline.getTime()
                    )
                ) {

                    await connection.rollback();

                    return res.status(500).json({
                        success: false,
                        message:
                            "Invalid payment deadline"
                    });
                }

                if (
                    new Date() >
                    paymentDeadline
                ) {

                    await connection.rollback();

                    return res.status(410).json({
                        success: false,
                        message:
                            "Payment deadline has expired"
                    });
                }
            }

            // -------------------------------------------------
            // 8. CHECK EXISTING PURCHASE
            // -------------------------------------------------

            const [existingPurchases] =
                await connection.query(
                    `SELECT
                        id,
                        buyer_id,
                        purchase_price,
                        status
                     FROM vehicle_purchases
                     WHERE vehicle_id = ?
                     LIMIT 1
                     FOR UPDATE`,
                    [auction.vehicle_id]
                );

            if (
                existingPurchases.length > 0
            ) {

                const purchase =
                    existingPurchases[0];

                if (
                    Number(purchase.buyer_id) ===
                    bidderId
                ) {

                    await connection.query(
                        `UPDATE auctions
                         SET
                            settlement_status =
                                'completed',
                            settled_at =
                                COALESCE(
                                    settled_at,
                                    NOW()
                                ),
                            settlement_reference =
                                COALESCE(
                                    settlement_reference,
                                    ?
                                )
                         WHERE id = ?`,
                        [
                            `SETTLEMENT-${auction.id}`,
                            auction.id
                        ]
                    );

                    await connection.commit();

                    return res.status(200).json({
                        success: true,
                        message:
                            "Auction payment was already completed",
                        auction_id:
                            auction.id,
                        purchase_id:
                            purchase.id
                    });
                }

                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    message:
                        "This vehicle has already been purchased"
                });
            }

            // -------------------------------------------------
            // 9. LOCK BUYER + SELLER
            // -------------------------------------------------

            const sellerId =
                Number(auction.seller_id);

            if (
                !Number.isInteger(sellerId)
            ) {

                throw new Error(
                    "Invalid seller ID"
                );
            }

            const [users] =
                await connection.query(
                    `SELECT
                        id,
                        wallet_balance
                     FROM users
                     WHERE id IN (?, ?)
                     ORDER BY id
                     FOR UPDATE`,
                    [
                        bidderId,
                        sellerId
                    ]
                );

            const buyer =
                users.find(
                    user =>
                        Number(user.id) ===
                        bidderId
                );

            const seller =
                users.find(
                    user =>
                        Number(user.id) ===
                        sellerId
                );

            if (!buyer) {

                throw new Error(
                    "Buyer account not found"
                );
            }

            if (!seller) {

                throw new Error(
                    "Seller account not found"
                );
            }

            // -------------------------------------------------
            // 10. CHECK BUYER BALANCE
            // -------------------------------------------------

            const buyerBalance =
                Number(
                    buyer.wallet_balance
                );

            if (
                !Number.isFinite(
                    buyerBalance
                ) ||
                buyerBalance < finalPrice
            ) {

                await connection.rollback();

                return res.status(402).json({
                    success: false,
                    message:
                        "Insufficient wallet balance",
                    required_amount:
                        finalPrice,
                    wallet_balance:
                        buyerBalance,
                    payment_required:
                        true
                });
            }

            // -------------------------------------------------
            // 11. CREATE SETTLEMENT REFERENCE
            // -------------------------------------------------

            const settlementReference =
                `SETTLEMENT-${auction.id}`;

            // -------------------------------------------------
            // 12. MARK PROCESSING
            // -------------------------------------------------

            await connection.query(
                `UPDATE auctions
                 SET settlement_status =
                     'processing'
                 WHERE id = ?
                   AND settlement_status IN
                       ('pending', 'processing')`,
                [auction.id]
            );

            // -------------------------------------------------
            // 13. DEBIT BUYER
            // -------------------------------------------------

            const [debitResult] =
                await connection.query(
                    `UPDATE users
                     SET wallet_balance =
                         wallet_balance - ?
                     WHERE id = ?
                       AND wallet_balance >= ?`,
                    [
                        finalPrice,
                        bidderId,
                        finalPrice
                    ]
                );

            if (
                debitResult.affectedRows !== 1
            ) {

                throw new Error(
                    "Buyer wallet debit failed"
                );
            }

            // -------------------------------------------------
            // 14. BUYER TRANSACTION
            // -------------------------------------------------

            await connection.query(
                `INSERT INTO wallet_transactions
                (
                    user_id,
                    type,
                    amount,
                    description,
                    reference_id
                )
                VALUES (?, 'debit', ?, ?, ?)`,
                [
                    bidderId,
                    finalPrice,
                    `Payment for vehicle ${auction.vehicle_id}`,
                    settlementReference
                ]
            );

            // -------------------------------------------------
            // 15. CREDIT SELLER
            // -------------------------------------------------

            await connection.query(
                `UPDATE users
                 SET wallet_balance =
                     wallet_balance + ?
                 WHERE id = ?`,
                [
                    finalPrice,
                    sellerId
                ]
            );

            // -------------------------------------------------
            // 16. SELLER TRANSACTION
            // -------------------------------------------------

            await connection.query(
                `INSERT INTO wallet_transactions
                (
                    user_id,
                    type,
                    amount,
                    description,
                    reference_id
                )
                VALUES (?, 'credit', ?, ?, ?)`,
                [
                    sellerId,
                    finalPrice,
                    `Payment received for vehicle ${auction.vehicle_id}`,
                    settlementReference
                ]
            );

            // -------------------------------------------------
            // 17. CREATE PURCHASE
            // -------------------------------------------------

            const [purchaseResult] =
                await connection.query(
                    `INSERT INTO vehicle_purchases
                    (
                        vehicle_id,
                        buyer_id,
                        purchase_price,
                        status
                    )
                    VALUES (?, ?, ?, 'completed')`,
                    [
                        auction.vehicle_id,
                        bidderId,
                        finalPrice
                    ]
                );
            // -------------------------------------------------
           // 18. MARK VEHICLE AS SOLD
          // -------------------------------------------------

          const [vehicleUpdateResult] =
          await connection.query(
          `UPDATE vehicles
         SET
             sale_status = 'sold',
             sold_at = NOW(),
             sold_to = ?
         WHERE id = ?
           AND sale_status <> 'sold'`,
        [
            bidderId,
            auction.vehicle_id
        ]
    );

        if (vehicleUpdateResult.affectedRows !== 1) {
    throw new Error(
        `Vehicle sale-state update failed for ${auction.vehicle_id}`
    );
     }
            // -------------------------------------------------
            // 19. COMPLETE AUCTION
            // -------------------------------------------------

            await connection.query(
                `UPDATE auctions
                 SET
                    settlement_status =
                        'completed',
                    settled_at =
                        NOW(),
                    settlement_reference = ?
                 WHERE id = ?`,
                [
                    settlementReference,
                    auction.id
                ]
            );

            // -------------------------------------------------
            // 20. COMMIT TRANSACTION
            // -------------------------------------------------

            await connection.commit();

            // -------------------------------------------------
           // 21.Success RESPONSE
          // -------------------------------------------------

            return res.status(200).json({
                success: true,

                message:
                    "Auction payment completed successfully",

                auction_id:
                    auction.id,

                vehicle_id:
                    auction.vehicle_id,

                purchase_id:
                    purchaseResult.insertId,

                payment: {
                    amount:
                        finalPrice,

                    status:
                        "completed",

                    reference:
                        settlementReference
                }
            });

        } catch (error) {

            if (connection) {

                try {
                    await connection.rollback();
                } catch (rollbackError) {

                    console.error(
                        "Payment rollback error:",
                        rollbackError
                    );
                }
            }

            console.error(
                "Auction payment error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Failed to complete auction payment"
            });

        } finally {

            if (connection) {
                connection.release();
            }
        }
    }
);
module.exports = router;