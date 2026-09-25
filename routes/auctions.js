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

    // Use the dynamically extended end time when available.
    // Fall back to end_time for older auctions.
    const endTime = new Date(
        auction.current_end_time || auction.end_time
    );

    let newStatus;

    if (now < startTime) {
        newStatus = "upcoming";
    } else if (now >= startTime && now < endTime) {
        newStatus = "active";
    } else {
        newStatus = "ended";
    }

    if (auction.status !== newStatus) {
        await connection.query(
            `UPDATE auctions
             SET status = ?
             WHERE id = ?`,
            [newStatus, auction.id]
        );

        auction.status = newStatus;
    }

    return auction;
};
// =====================================================
// FINALIZE AUCTION
// =====================================================

const finalizeAuction = async (connection, auction) => {
    const now = new Date();

    // Use the dynamically extended end time when available.
    // Fall back to end_time for older auctions.
    const endTime = new Date(
        auction.current_end_time || auction.end_time
    );

    // Auction has not ended yet
    if (now < endTime) {
        return {
            finalized: false,
            winner: null
        };
    }

    // Already finalized
    if (auction.status === "ended") {
        return {
            finalized: true,
            winner:
                auction.reserve_met && auction.high_bidder_id
                    ? {
                        bidder_id: auction.high_bidder_id,
                        bidder_name: auction.high_bidder
                    }
                    : null
        };
    }

    // Mark auction as ended
    await connection.query(
        `UPDATE auctions
         SET status = 'ended'
         WHERE id = ?`,
        [auction.id]
    );

    auction.status = "ended";

    // Reserve price was not met or there was no bidder
    if (!auction.reserve_met || !auction.high_bidder_id) {
        return {
            finalized: true,
            winner: null
        };
    }

    // Reserve price was met and a highest bidder exists
    return {
        finalized: true,
        winner: {
            bidder_id: auction.high_bidder_id,
            bidder_name: auction.high_bidder
        }
    };
};
const formatAuctionResponse = (auction) => { 
const formattedAuction = { ...auction }; 
   if (formattedAuction.status === "ended") {
     formattedAuction.final_bid = formattedAuction.current_bid;
      delete formattedAuction.current_bid;
       delete formattedAuction.vehicle_current_bid; 
    } else if (formattedAuction.status === "active") { 
        formattedAuction.current_bid = formattedAuction.current_bid || 0; 
        delete formattedAuction.final_bid; 
        delete formattedAuction.vehicle_current_bid;
     } else {
         delete formattedAuction.current_bid; 
         delete formattedAuction.final_bid;
          delete formattedAuction.vehicle_current_bid;
    }
     return formattedAuction;
};
// =====================================================
// GET ALL AUCTIONS
// =====================================================

router.get("/", async (req, res) => {
    try {
        const [auctions] = await db.query(
            `SELECT
                a.*,
                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage,
                v.current_bid AS vehicle_current_bid,
                v.seller_id
             FROM auctions a
             INNER JOIN vehicles v
                ON a.vehicle_id = v.id
             ORDER BY a.start_time ASC`
        );

        // Update status of each auction according to its time
        for (const auction of auctions) {
            await updateAuctionStatus(db, auction);
        }

        // Format auction data according to its current lifecycle state
        const formattedAuctions = auctions.map(formatAuctionResponse);

        res.status(200).json({
            success: true,
            count: formattedAuctions.length,
            auctions: formattedAuctions
        });

    } catch (error) {
        console.error("Get all auctions error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch auctions"
        });
    }
});
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
                a.starting_bid,
                a.current_bid,
                a.reserve_price,
                a.reserve_met,
                a.bid_count,
                a.status,
                a.high_bidder,
                a.high_bidder_id,

                v.title AS vehicle_title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.primary_damage

             FROM bids b

             INNER JOIN auctions a
                 ON b.auction_id = a.id

             INNER JOIN vehicles v
                 ON b.vehicle_id = v.id

             WHERE b.bidder_id = ?

             ORDER BY b.bid_time DESC`,
            [bidderId]
        );

        // Update auction status and finalize auctions whose
        // end time has already passed.
        const processedAuctions = new Set();

        for (const bid of bids) {
            if (!processedAuctions.has(bid.auction_id)) {
                await updateAuctionStatus(db, bid);
                await finalizeAuction(db, bid);

                processedAuctions.add(bid.auction_id);
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
                status: auction.status
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
// GET MY AUCTIONS (seller)
router.get("/my-auctions", authenticateToken, async (req, res) => {
    try {
        const sellerId = req.user.userId;

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
             WHERE v.seller_id = ?
             ORDER BY a.start_time DESC`,
            [sellerId]
        );

        // Update auction status according to its time
        for (const auction of auctions) {
            await updateAuctionStatus(db, auction);
        }

        // Format auction data according to its lifecycle state
        const formattedAuctions = auctions.map(formatAuctionResponse);

        res.status(200).json({
            success: true,
            count: formattedAuctions.length,
            auctions: formattedAuctions
        });

    } catch (error) {
        console.error("Get my auctions error:", error);

        res.status(500).json({
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

        // Update auction status according to its time
        await updateAuctionStatus(db, auction);

        // Finalize auction if its end time has passed
        const finalization = await finalizeAuction(db, auction);

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

await updateAuctionStatus(db, auction);

const finalization = await finalizeAuction(db, auction);

const formattedAuction = formatAuctionResponse(auction);

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

        const auction = auctions[0];

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


module.exports = router;