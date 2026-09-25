const express = require("express");
const crypto = require("crypto");
const db = require("../config/db");
const authenticateToken = require("../middleware/authMiddleware");

const router = express.Router();


// ======================================================
// GET ALL VEHICLES
// GET /api/vehicles
// ======================================================

router.get("/", async (req, res) => {
    try {

        // Get all vehicles from database
        const [vehicles] = await db.query(
            `SELECT *
             FROM vehicles
             ORDER BY created_at DESC`
        );

        res.status(200).json({
            success: true,
            count: vehicles.length,
            vehicles: vehicles
        });

    } catch (error) {

        console.error("Get vehicles error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch vehicles"
        });
    }
});
// ======================================================
// GET MY VEHICLE LISTINGS
// GET /api/vehicles/my-listings
// ======================================================

router.get("/my-listings", authenticateToken, async (req, res) => {
    try {

        // Get logged-in user's ID from JWT
        const sellerId = req.user.userId;

        // Get vehicles listed by this user
        const [vehicles] = await db.query(
            `SELECT *
             FROM vehicles
             WHERE seller_id = ?
             ORDER BY created_at DESC`,
            [sellerId]
        );

        res.status(200).json({
            success: true,
            count: vehicles.length,
            vehicles: vehicles
        });

    } catch (error) {

        console.error("Get my listings error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch your vehicle listings"
        });
    }
});
// =====================================================
// GET MY WATCHLIST
// =====================================================

router.get("/my-watchlist", authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const [watchlist] = await db.query(
            `SELECT
                w.id AS watchlist_id,
                w.vehicle_id,
                w.created_at,

                v.title,
                v.make,
                v.model,
                v.year,
                v.category,
                v.fuel_type,
                v.transmission,
                v.primary_damage,
                v.secondary_damage,
                v.current_bid,
                v.reserve_price,
                v.buy_it_now_price,
                v.est_retail_value,
                v.bid_count,
                v.auction_ends_in_seconds

             FROM watchlists w

             INNER JOIN vehicles v
                 ON w.vehicle_id = v.id

             WHERE w.user_id = ?

             ORDER BY w.created_at DESC`,
            [userId]
        );

        res.status(200).json({
            success: true,
            count: watchlist.length,
            watchlist: watchlist
        });

    } catch (error) {
        console.error("Get my watchlist error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch your watchlist"
        });
    }
});
// =====================================================
// ADD VEHICLE TO WATCHLIST
// =====================================================

router.post("/:id/watchlist", authenticateToken, async (req, res) => {
    try {
        const vehicleId = req.params.id;
        const userId = req.user.userId;

        // Check whether the vehicle exists
        const [vehicles] = await db.query(
            `SELECT id
             FROM vehicles
             WHERE id = ?`,
            [vehicleId]
        );

        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        // Check whether it is already in the user's watchlist
        const [existing] = await db.query(
            `SELECT id
             FROM watchlists
             WHERE user_id = ? AND vehicle_id = ?`,
            [userId, vehicleId]
        );

        if (existing.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Vehicle is already in your watchlist"
            });
        }

        // Add vehicle to watchlist
        await db.query(
            `INSERT INTO watchlists
            (user_id, vehicle_id)
            VALUES (?, ?)`,
            [userId, vehicleId]
        );

        res.status(201).json({
            success: true,
            message: "Vehicle added to watchlist successfully"
        });

    } catch (error) {
        console.error("Add watchlist error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to add vehicle to watchlist"
        });
    }
});
// =====================================================
// REMOVE VEHICLE FROM WATCHLIST
// =====================================================

router.delete("/:id/watchlist", authenticateToken, async (req, res) => {
    try {
        const vehicleId = req.params.id;
        const userId = req.user.userId;

        const [result] = await db.query(
            `DELETE FROM watchlists
             WHERE user_id = ? AND vehicle_id = ?`,
            [userId, vehicleId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle is not in your watchlist"
            });
        }

        res.status(200).json({
            success: true,
            message: "Vehicle removed from watchlist successfully"
        });

    } catch (error) {
        console.error("Remove watchlist error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to remove vehicle from watchlist"
        });
    }
});
// ======================================================
// BUY IT NOW
// POST /api/vehicles/:id/buy
// ======================================================

router.post("/:id/buy", authenticateToken, async (req, res) => {

    const connection = await db.getConnection();

    try {

        const vehicleId = req.params.id;
        const buyerId = req.user.userId;

        await connection.beginTransaction();

        const [vehicles] = await connection.query(
            `SELECT *
             FROM vehicles
             WHERE id = ?
             FOR UPDATE`,
            [vehicleId]
        );

        if (vehicles.length === 0) {
            await connection.rollback();
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        const vehicle = vehicles[0];

        // Seller protection
        if (Number(vehicle.seller_id) === Number(buyerId)) {
            await connection.rollback();
            return res.status(403).json({
                success: false,
                message: "You cannot buy your own vehicle"
            });
        }

        const buyNowPrice = Number(vehicle.buy_it_now_price);

        if (
            vehicle.buy_it_now_price === null ||
            !Number.isFinite(buyNowPrice) ||
            buyNowPrice <= 0
        ) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Buy It Now is not available for this vehicle"
            });
        }

        // Check whether vehicle is already purchased
        const [existingPurchases] = await connection.query(
            `SELECT id
             FROM vehicle_purchases
             WHERE vehicle_id = ?
             LIMIT 1
             FOR UPDATE`,
            [vehicleId]
        );

        if (existingPurchases.length > 0) {
            await connection.rollback();
            return res.status(409).json({
                success: false,
                message: "This vehicle has already been purchased"
            });
        }

        // Check auction
        const [auctions] = await connection.query(
            `SELECT
                id,
                status,
                reserve_met,
                high_bidder_id
             FROM auctions
             WHERE vehicle_id = ?
             LIMIT 1
             FOR UPDATE`,
            [vehicleId]
        );

        if (auctions.length > 0) {

            const auction = auctions[0];

            // Auction already produced a winner
            if (
                auction.status === "ended" &&
                Number(auction.reserve_met) === 1 &&
                auction.high_bidder_id !== null
            ) {
                await connection.rollback();
                return res.status(409).json({
                    success: false,
                    message: "This vehicle has already been won through auction"
                });
            }

            // Stop active/upcoming auction
            if (
                auction.status === "active" ||
                auction.status === "upcoming"
            ) {
                await connection.query(
                    `UPDATE auctions
                     SET
                        status = 'ended',
                        current_end_time = NOW()
                     WHERE id = ?`,
                    [auction.id]
                );
            }
        }

        // Create purchase
        const [purchaseResult] = await connection.query(
            `INSERT INTO vehicle_purchases (
                vehicle_id,
                buyer_id,
                purchase_price,
                status
            )
            VALUES (?, ?, ?, 'completed')`,
            [
                vehicleId,
                buyerId,
                buyNowPrice
            ]
        );

        await connection.commit();

        res.status(201).json({
            success: true,
            message: "Vehicle purchased successfully",
            purchase: {
                id: purchaseResult.insertId,
                vehicle_id: vehicleId,
                buyer_id: buyerId,
                purchase_price: buyNowPrice,
                status: "completed"
            }
        });

    } catch (error) {

        try {
            await connection.rollback();
        } catch (rollbackError) {
            console.error("Rollback error:", rollbackError);
        }

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "This vehicle has already been purchased"
            });
        }

        console.error("Buy It Now error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to complete vehicle purchase"
        });

    } finally {

        connection.release();
    }
});
// ======================================================
// GET SINGLE VEHICLE
// GET /api/vehicles/:id
// ======================================================

router.get("/:id", async (req, res) => {
    try {

        // Get vehicle ID from URL
        const vehicleId = req.params.id;

        // Find vehicle in database
        const [vehicles] = await db.query(
            `SELECT *
             FROM vehicles
             WHERE id = ?`,
            [vehicleId]
        );

        // Vehicle not found
        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        // Return vehicle
        res.status(200).json({
            success: true,
            vehicle: vehicles[0]
        });

    } catch (error) {

        console.error("Get vehicle error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch vehicle"
        });
    }
});
// ======================================================
// GET VEHICLE IMAGES
// GET /api/vehicles/:id/images
// ======================================================

router.get("/:id/images", async (req, res) => {
    try {

        // Get vehicle ID from URL
        const vehicleId = req.params.id;

        // Check whether vehicle exists
        const [vehicles] = await db.query(
            `SELECT id
             FROM vehicles
             WHERE id = ?`,
            [vehicleId]
        );

        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found"
            });
        }

        // Get images belonging to the vehicle
        const [images] = await db.query(
            `SELECT *
             FROM vehicle_images
             WHERE vehicle_id = ?
             ORDER BY sort_order ASC`,
            [vehicleId]
        );

        res.status(200).json({
            success: true,
            count: images.length,
            images: images
        });

    } catch (error) {

        console.error("Get vehicle images error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to fetch vehicle images"
        });
    }
});
// ======================================================
// CREATE VEHICLE LISTING
// POST /api/vehicles
// ======================================================

router.post("/", authenticateToken, async (req, res) => {
    try {

        // Get logged-in user's ID from JWT
        const sellerId = req.user.userId;

        const {
            title,
            make,
            model,
            year,
            category,
            fuel_type,
            transmission,
            reg_no,
            vin,
            condition_type,
            run_and_drive,
            primary_damage,
            secondary_damage,
            sale_type,
            reserve_price,
            buy_it_now_price,
            est_retail_value
        } = req.body;


        // ==================================================
        // REQUIRED FIELD VALIDATION
        // ==================================================

        if (!title || !make || !model || !year || !category || !sale_type) {
            return res.status(400).json({
                success: false,
                message: "Title, make, model, year, category and sale type are required"
            });
        }


        // ==================================================
        // YEAR VALIDATION
        // ==================================================

        const vehicleYear = Number(year);

        if (
            !Number.isInteger(vehicleYear) ||
            vehicleYear < 1900 ||
            vehicleYear > new Date().getFullYear() + 1
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid vehicle year"
            });
        }


        // ==================================================
        // SALE TYPE VALIDATION
        // ==================================================

        const allowedSaleTypes = ["auction", "buy_it_now"];

        if (!allowedSaleTypes.includes(sale_type)) {
            return res.status(400).json({
                success: false,
                message: "Invalid sale type"
            });
        }


        // ==================================================
        // PRICE VALIDATION
        // ==================================================

        const reservePrice =
            reserve_price === undefined ||
            reserve_price === null ||
            reserve_price === ""
                ? 0
                : Number(reserve_price);

        const buyNowPrice =
            buy_it_now_price === undefined ||
            buy_it_now_price === null ||
            buy_it_now_price === ""
                ? null
                : Number(buy_it_now_price);

        const retailValue =
            est_retail_value === undefined ||
            est_retail_value === null ||
            est_retail_value === ""
                ? null
                : Number(est_retail_value);


        if (
            !Number.isFinite(reservePrice) ||
            reservePrice < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Reserve price must be a valid positive number"
            });
        }


        if (
            buyNowPrice !== null &&
            (!Number.isFinite(buyNowPrice) || buyNowPrice < 0)
        ) {
            return res.status(400).json({
                success: false,
                message: "Buy It Now price must be a valid positive number"
            });
        }


        if (
            retailValue !== null &&
            (!Number.isFinite(retailValue) || retailValue < 0)
        ) {
            return res.status(400).json({
                success: false,
                message: "Estimated retail value must be a valid positive number"
            });
        }


        // ==================================================
        // GENERATE VEHICLE ID AND LOT NUMBER
        // ==================================================

        const vehicleId = `car_${crypto.randomBytes(6).toString("hex")}`;

        const lotNumber =
            `LOT-${Date.now()}-${Math.floor(Math.random() * 1000)}`;


        // ==================================================
        // INSERT VEHICLE
        // ==================================================

        await db.query(
            `INSERT INTO vehicles (
                id,
                seller_id,
                lot_number,
                title,
                make,
                model,
                year,
                category,
                fuel_type,
                transmission,
                reg_no,
                vin,
                sale_type,
                condition_type,
                run_and_drive,
                current_bid,
                reserve_price,
                reserve_met,
                buy_it_now_price,
                est_retail_value,
                bid_count,
                auction_ends_in_seconds,
                primary_damage,
                secondary_damage
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                vehicleId,
                sellerId,
                lotNumber,
                title.trim(),
                make.trim(),
                model.trim(),
                vehicleYear,
                category,
                fuel_type || null,
                transmission || null,
                reg_no || null,
                vin || null,
                sale_type,
                condition_type || "used",
                run_and_drive || null,
                0,
                reservePrice,
                0,
                buyNowPrice,
                retailValue,
                0,
                0,
                primary_damage || null,
                secondary_damage || null
            ]
        );


        // ==================================================
        // RETURN CREATED VEHICLE
        // ==================================================

        const [vehicles] = await db.query(
            `SELECT *
             FROM vehicles
             WHERE id = ?`,
            [vehicleId]
        );


        res.status(201).json({
            success: true,
            message: "Vehicle listed successfully",
            vehicle: vehicles[0]
        });


    } catch (error) {

        console.error("Create vehicle error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to create vehicle listing"
        });
    }
});
// ======================================================
// UPDATE VEHICLE LISTING
// PUT /api/vehicles/:id
// ======================================================

router.put("/:id", authenticateToken, async (req, res) => {
    try {

        // Get vehicle ID from URL
        const vehicleId = req.params.id;

        // Get logged-in user's ID from JWT
        const sellerId = req.user.userId;


        // ==================================================
        // CHECK VEHICLE OWNERSHIP
        // ==================================================

        const [vehicles] = await db.query(
            `SELECT *
             FROM vehicles
             WHERE id = ? AND seller_id = ?`,
            [vehicleId, sellerId]
        );

        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found or you are not authorized to update it"
            });
        }

        const existingVehicle = vehicles[0];


        // ==================================================
        // GET VALUES FROM REQUEST
        // ==================================================

        const {
            title,
            make,
            model,
            year,
            category,
            fuel_type,
            transmission,
            reg_no,
            vin,
            condition_type,
            run_and_drive,
            primary_damage,
            secondary_damage,
            sale_type,
            reserve_price,
            buy_it_now_price,
            est_retail_value
        } = req.body;


        // ==================================================
        // KEEP EXISTING VALUES IF FIELD IS NOT PROVIDED
        // ==================================================

        const updatedTitle =
            title !== undefined ? title.trim() : existingVehicle.title;

        const updatedMake =
            make !== undefined ? make.trim() : existingVehicle.make;

        const updatedModel =
            model !== undefined ? model.trim() : existingVehicle.model;

        const updatedYear =
            year !== undefined ? Number(year) : existingVehicle.year;

        const updatedCategory =
            category !== undefined ? category : existingVehicle.category;

        const updatedFuelType =
            fuel_type !== undefined ? fuel_type : existingVehicle.fuel_type;

        const updatedTransmission =
            transmission !== undefined
                ? transmission
                : existingVehicle.transmission;

        const updatedRegNo =
            reg_no !== undefined ? reg_no : existingVehicle.reg_no;

        const updatedVin =
            vin !== undefined ? vin : existingVehicle.vin;

        const updatedConditionType =
            condition_type !== undefined
                ? condition_type
                : existingVehicle.condition_type;

        const updatedRunAndDrive =
            run_and_drive !== undefined
                ? run_and_drive
                : existingVehicle.run_and_drive;

        const updatedPrimaryDamage =
            primary_damage !== undefined
                ? primary_damage
                : existingVehicle.primary_damage;

        const updatedSecondaryDamage =
            secondary_damage !== undefined
                ? secondary_damage
                : existingVehicle.secondary_damage;

        const updatedSaleType =
            sale_type !== undefined
                ? sale_type
                : existingVehicle.sale_type;


        // ==================================================
        // PRICE VALUES
        // ==================================================

        const updatedReservePrice =
            reserve_price !== undefined
                ? Number(reserve_price)
                : Number(existingVehicle.reserve_price);

        const updatedBuyNowPrice =
            buy_it_now_price !== undefined
                ? (
                    buy_it_now_price === null ||
                    buy_it_now_price === ""
                        ? null
                        : Number(buy_it_now_price)
                )
                : existingVehicle.buy_it_now_price;

        const updatedRetailValue =
            est_retail_value !== undefined
                ? (
                    est_retail_value === null ||
                    est_retail_value === ""
                        ? null
                        : Number(est_retail_value)
                )
                : existingVehicle.est_retail_value;


        // ==================================================
        // REQUIRED FIELD VALIDATION
        // ==================================================

        if (
            !updatedTitle ||
            !updatedMake ||
            !updatedModel ||
            !updatedYear ||
            !updatedCategory ||
            !updatedSaleType
        ) {
            return res.status(400).json({
                success: false,
                message: "Title, make, model, year, category and sale type are required"
            });
        }


        // ==================================================
        // YEAR VALIDATION
        // ==================================================

        if (
            !Number.isInteger(updatedYear) ||
            updatedYear < 1900 ||
            updatedYear > new Date().getFullYear() + 1
        ) {
            return res.status(400).json({
                success: false,
                message: "Please enter a valid vehicle year"
            });
        }


        // ==================================================
        // SALE TYPE VALIDATION
        // ==================================================

        const allowedSaleTypes = [
            "auction",
            "buy_it_now"
        ];

        if (!allowedSaleTypes.includes(updatedSaleType)) {
            return res.status(400).json({
                success: false,
                message: "Invalid sale type"
            });
        }


        // ==================================================
        // PRICE VALIDATION
        // ==================================================

        if (
            !Number.isFinite(updatedReservePrice) ||
            updatedReservePrice < 0
        ) {
            return res.status(400).json({
                success: false,
                message: "Reserve price must be a valid positive number"
            });
        }


        if (
            updatedBuyNowPrice !== null &&
            (
                !Number.isFinite(Number(updatedBuyNowPrice)) ||
                Number(updatedBuyNowPrice) < 0
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Buy It Now price must be a valid positive number"
            });
        }


        if (
            updatedRetailValue !== null &&
            (
                !Number.isFinite(Number(updatedRetailValue)) ||
                Number(updatedRetailValue) < 0
            )
        ) {
            return res.status(400).json({
                success: false,
                message: "Estimated retail value must be a valid positive number"
            });
        }


        // ==================================================
        // UPDATE VEHICLE
        // ==================================================

        await db.query(
            `UPDATE vehicles
             SET
                title = ?,
                make = ?,
                model = ?,
                year = ?,
                category = ?,
                fuel_type = ?,
                transmission = ?,
                reg_no = ?,
                vin = ?,
                sale_type = ?,
                condition_type = ?,
                run_and_drive = ?,
                reserve_price = ?,
                buy_it_now_price = ?,
                est_retail_value = ?,
                primary_damage = ?,
                secondary_damage = ?
             WHERE id = ? AND seller_id = ?`,
            [
                updatedTitle,
                updatedMake,
                updatedModel,
                updatedYear,
                updatedCategory,
                updatedFuelType,
                updatedTransmission,
                updatedRegNo,
                updatedVin,
                updatedSaleType,
                updatedConditionType,
                updatedRunAndDrive,
                updatedReservePrice,
                updatedBuyNowPrice,
                updatedRetailValue,
                updatedPrimaryDamage,
                updatedSecondaryDamage,
                vehicleId,
                sellerId
            ]
        );


        // ==================================================
        // GET UPDATED VEHICLE
        // ==================================================

        const [updatedVehicles] = await db.query(
            `SELECT *
             FROM vehicles
             WHERE id = ?`,
            [vehicleId]
        );


        res.status(200).json({
            success: true,
            message: "Vehicle listing updated successfully",
            vehicle: updatedVehicles[0]
        });


    } catch (error) {

        console.error("Update vehicle error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to update vehicle listing"
        });
    }
});
// ======================================================
// DELETE VEHICLE LISTING
// DELETE /api/vehicles/:id
// ======================================================

router.delete("/:id", authenticateToken, async (req, res) => {
    try {

        // Get vehicle ID from URL
        const vehicleId = req.params.id;

        // Get logged-in user's ID from JWT
        const sellerId = req.user.userId;


        // ==================================================
        // CHECK VEHICLE OWNERSHIP
        // ==================================================

        const [vehicles] = await db.query(
            `SELECT id
             FROM vehicles
             WHERE id = ? AND seller_id = ?`,
            [vehicleId, sellerId]
        );

        if (vehicles.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Vehicle not found or you are not authorized to delete it"
            });
        }


        // ==================================================
        // CHECK WHETHER AUCTION EXISTS
        // ==================================================

        const [auctions] = await db.query(
            `SELECT id, status
             FROM auctions
             WHERE vehicle_id = ?
             LIMIT 1`,
            [vehicleId]
        );

        if (auctions.length > 0) {
            return res.status(409).json({
                success: false,
                message: "This vehicle cannot be deleted because an auction has already been created for it"
            });
        }


        // ==================================================
        // CHECK WHETHER ANY BIDS EXIST
        // ==================================================

        const [bids] = await db.query(
            `SELECT id
             FROM bids
             WHERE vehicle_id = ?
             LIMIT 1`,
            [vehicleId]
        );

        if (bids.length > 0) {
            return res.status(409).json({
                success: false,
                message: "This vehicle cannot be deleted because bidding activity already exists"
            });
        }


        // ==================================================
        // DELETE VEHICLE
        // ==================================================

        await db.query(
            `DELETE FROM vehicles
             WHERE id = ? AND seller_id = ?`,
            [vehicleId, sellerId]
        );


        // ==================================================
        // SUCCESS RESPONSE
        // ==================================================

        res.status(200).json({
            success: true,
            message: "Vehicle listing deleted successfully"
        });


    } catch (error) {

        console.error("Delete vehicle error:", error);

        res.status(500).json({
            success: false,
            message: "Failed to delete vehicle listing"
        });
    }
});

module.exports = router;