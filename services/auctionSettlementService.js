const db = require("../config/db");

/**
 * Process all auctions that have ended but have not been settled.
 *
 * This service is intentionally independent from API routes.
 * It can therefore run automatically in the background.
 */
const processEndedAuctions = async () => {
    let connection;

    try {
        connection = await db.getConnection();

        /*
         * Find auctions whose current auction time has expired
         * and which still require settlement.
         *
         * We deliberately do not depend on the stored "status"
         * because status can become stale if nobody has opened
         * the auction endpoint.
         */
        const [auctions] = await connection.query(
            `
            SELECT
                a.id,
                a.vehicle_id,
                a.start_time,
                a.end_time,
                a.scheduled_end_time,
                a.current_end_time,
                a.current_bid,
                a.reserve_price,
                a.reserve_met,
                a.high_bidder,
                a.high_bidder_id,
                v.seller_id AS seller_id,
                a.settlement_status,
                a.settled_at,
                a.settlement_reference,
                a.payment_deadline
            FROM auctions a
            INNER JOIN vehicles v
                ON a.vehicle_id = v.id
            WHERE
                (
                  a.settlement_status = 'pending'
                 AND COALESCE(
                      a.current_end_time,
                      a.end_time
                   ) <= NOW()
               )
    OR
    (
        a.settlement_status = 'payment_required'
        AND a.payment_deadline IS NOT NULL
        AND a.payment_deadline <= NOW()
    )
 ORDER BY a.id ASC
            `
             
        );

        if (auctions.length === 0) {
            return;
        }

        console.log(
            `[Auction Worker] Found ${auctions.length} auction(s) requiring processing.`
        );

        for (const auction of auctions) {
            await processSingleAuction(auction);
        }

    } catch (error) {
        console.error(
            "[Auction Worker] Processing error:",
            error
        );

    } finally {
        if (connection) {
            connection.release();
        }
    }
};


/**
 * Process one auction inside its own transaction.
 */
const processSingleAuction = async (auction) => {
    let connection;

    try {
        connection = await db.getConnection();

        await connection.beginTransaction();

        /*
         * Lock the auction row.
         *
         * This is important because multiple worker cycles,
         * requests, or server instances must not settle
         * the same auction simultaneously.
         */
        const [lockedAuctions] = await connection.query(
            `
            SELECT
                a.*,
                v.seller_id
            FROM auctions a
            INNER JOIN vehicles v
                ON a.vehicle_id = v.id
            WHERE a.id = ?
            FOR UPDATE
            `,
            [auction.id]
        );

        if (lockedAuctions.length === 0) {
            await connection.rollback();
            return;
        }

        const currentAuction = lockedAuctions[0];

        /*
         * Another process may have settled this auction
         * between discovery and locking.
         */
        if (
            currentAuction.settlement_status === "completed" ||
            currentAuction.settlement_status === "no_winner"
        ) {
            await connection.commit();
            return;
        }
        /*
 * --------------------------------------------------
 * PAYMENT DEADLINE EXPIRY
 * --------------------------------------------------
 *
 * If the auction previously entered payment_required
 * but the winner did not pay before the deadline,
 * expire the payment requirement.
 *
 * IMPORTANT:
 * We do not debit the winner here because no payment
 * was successfully completed.
 */
if (
    currentAuction.settlement_status === "payment_required" &&
    currentAuction.payment_deadline &&
    new Date(currentAuction.payment_deadline) <= new Date()
) {
    await connection.query(
        `
        UPDATE auctions
        SET
            settlement_status = 'payment_expired',
            settled_at = NOW(),
            settlement_reference = ?
        WHERE id = ?
        `,
        [
            `SET-${currentAuction.id}-PAYMENTEXPIRED`,
            currentAuction.id
        ]
    );

    await connection.commit();

    console.log(
        `[Auction Worker] Auction ${currentAuction.id}: payment expired.`
    );

    return;
}
        /*
         * Make sure the auction really has ended.
         */
        const endTime = new Date(
            currentAuction.current_end_time ||
            currentAuction.end_time
        );

        if (
            Number.isNaN(endTime.getTime()) ||
            endTime > new Date()
        ) {
            await connection.rollback();
            return;
        }

        /*
         * Always mark the auction as ended once its
         * effective end time has passed.
         */
        if (currentAuction.status !== "ended") {
            await connection.query(
                `
                UPDATE auctions
                SET status = 'ended'
                WHERE id = ?
                `,
                [currentAuction.id]
            );
        }

        /*
         * --------------------------------------------------
         * NO WINNER
         * --------------------------------------------------
         *
         * Reserve price was not reached or nobody bid.
         */
        if (
            !currentAuction.high_bidder_id ||
            Number(currentAuction.reserve_met) !== 1
        ) {
            await connection.query(
                `
                UPDATE auctions
                SET
                    settlement_status = 'no_winner',
                    settled_at = NOW(),
                    settlement_reference = ?
                WHERE id = ?
                `,
                [
                    `SET-${currentAuction.id}-NOWINNER`,
                    currentAuction.id
                ]
            );

            await connection.commit();

            console.log(
                `[Auction Worker] Auction ${currentAuction.id}: no winner.`
            );

            return;
        }

        const winnerId = Number(
            currentAuction.high_bidder_id
        );

        const sellerId = Number(
            currentAuction.seller_id
        );

        const finalPrice = Number(
            currentAuction.current_bid
        );

        /*
         * Basic integrity validation.
         */
        if (
            !Number.isInteger(winnerId) ||
            !Number.isInteger(sellerId) ||
            !Number.isFinite(finalPrice) ||
            finalPrice <= 0
        ) {
            throw new Error(
                `Invalid settlement data for auction ${currentAuction.id}`
            );
        }

        /*
         * --------------------------------------------------
         * EXISTING PURCHASE CHECK
         * --------------------------------------------------
         */
        const [existingPurchases] = await connection.query(
            `
            SELECT 
            id ,
            buyer_id
            FROM vehicle_purchases
            WHERE vehicle_id = ?
            LIMIT 1
            FOR UPDATE
            `,
            [currentAuction.vehicle_id]
        );
        if (existingPurchases.length > 0) {

    const existingPurchase = existingPurchases[0];

    /*
     * The vehicle already has a purchase record.
     *
     * Make sure the vehicle itself also reflects
     * the sold state before completing the auction.
     */
    await connection.query(
        `
        UPDATE vehicles
        SET
            sale_status = 'sold',
            sold_at = COALESCE(sold_at, NOW()),
            sold_to = COALESCE(sold_to, ?)
        WHERE id = ?
        `,
        [
            existingPurchase.buyer_id,
            currentAuction.vehicle_id
        ]
    );

    await connection.query(
        `
        UPDATE auctions
        SET
            status = 'ended',
            settlement_status = 'completed',
            settled_at = COALESCE(settled_at, NOW()),
            settlement_reference =
                COALESCE(
                    settlement_reference,
                    ?
                ),
            payment_deadline = NULL
        WHERE id = ?
        `,
        [
            `SET-${currentAuction.id}-EXISTING`,
            currentAuction.id
        ]
    );

    await connection.commit();

    console.log(
        `[Auction Worker] Auction ${currentAuction.id}: existing purchase detected. Vehicle marked as sold.`
    );

    return;
}

        /*
         * --------------------------------------------------
         * LOCK WINNER + SELLER
         * --------------------------------------------------
         */
        const [users] = await connection.query(
            `
            SELECT
                id,
                wallet_balance
            FROM users
            WHERE id IN (?, ?)
            FOR UPDATE
            `,
            [winnerId, sellerId]
        );

        const winner = users.find(
            user => Number(user.id) === winnerId
        );

        const seller = users.find(
            user => Number(user.id) === sellerId
        );

        if (!winner) {
            throw new Error(
                `Winner account ${winnerId} not found`
            );
        }

        if (!seller) {
            throw new Error(
                `Seller account ${sellerId} not found`
            );
        }

        /*
         * --------------------------------------------------
         * PAYMENT DEADLINE
         * --------------------------------------------------
         *
         * Winner gets 24 hours to pay.
         *
         * IMPORTANT:
         * We do NOT debit the wallet when the balance
         * is insufficient.
         */
        const winnerBalance = Number(
            winner.wallet_balance
        );

        if (
            !Number.isFinite(winnerBalance) ||
            winnerBalance < finalPrice
        ) {
            const paymentDeadline =
                currentAuction.payment_deadline ||
                new Date(Date.now() + 24 * 60 * 60 * 1000);

            await connection.query(
                `
                UPDATE auctions
                SET
                    settlement_status = 'payment_required',
                    payment_deadline = ?
                WHERE id = ?
                `,
                [
                    paymentDeadline,
                    currentAuction.id
                ]
            );

            await connection.commit();

            console.log(
                `[Auction Worker] Auction ${currentAuction.id}: payment required.`
            );

            return;
        }

        /*
         * --------------------------------------------------
         * SETTLEMENT REFERENCE
         * --------------------------------------------------
         */
        const settlementReference =
            `SET-${currentAuction.id}-${Date.now()}`;

        /*
         * --------------------------------------------------
         * MARK PROCESSING
         * --------------------------------------------------
         */
        await connection.query(
            `
            UPDATE auctions
            SET
                settlement_status = 'processing',
                settlement_reference = ?
            WHERE id = ?
            `,
            [
                settlementReference,
                currentAuction.id
            ]
        );

        /*
         * --------------------------------------------------
         * DEBIT WINNER
         * --------------------------------------------------
         */
        const [debitResult] = await connection.query(
            `
            UPDATE users
            SET wallet_balance =
                wallet_balance - ?
            WHERE
                id = ?
                AND wallet_balance >= ?
            `,
            [
                finalPrice,
                winnerId,
                finalPrice
            ]
        );

        if (debitResult.affectedRows !== 1) {
            throw new Error(
                `Wallet debit failed for winner ${winnerId}`
            );
        }

        /*
         * --------------------------------------------------
         * WALLET DEBIT TRANSACTION
         * --------------------------------------------------
         */
        await connection.query(
            `
            INSERT INTO wallet_transactions
            (
                user_id,
                type,
                amount,
                description,
                reference_id
            )
            VALUES (?, 'debit', ?, ?, ?)
            `,
            [
                winnerId,
                finalPrice,
                `Payment for vehicle ${currentAuction.vehicle_id}`,
                settlementReference
            ]
        );

        /*
         * --------------------------------------------------
         * CREDIT SELLER
         * --------------------------------------------------
         */
        await connection.query(
            `
            UPDATE users
            SET wallet_balance =
                wallet_balance + ?
            WHERE id = ?
            `,
            [
                finalPrice,
                sellerId
            ]
        );

        /*
         * --------------------------------------------------
         * WALLET CREDIT TRANSACTION
         * --------------------------------------------------
         */
        await connection.query(
            `
            INSERT INTO wallet_transactions
            (
                user_id,
                type,
                amount,
                description,
                reference_id
            )
            VALUES (?, 'credit', ?, ?, ?)
            `,
            [
                sellerId,
                finalPrice,
                `Sale payment for vehicle ${currentAuction.vehicle_id}`,
                settlementReference
            ]
        );

       /*
 * --------------------------------------------------
 * CREATE PURCHASE
 * --------------------------------------------------
 */
await connection.query(
    `
    INSERT INTO vehicle_purchases
    (
        vehicle_id,
        buyer_id,
        purchase_price,
        status
    )
    VALUES (?, ?, ?, 'completed')
    `,
    [
        currentAuction.vehicle_id,
        winnerId,
        finalPrice
    ]
);

/*
 * --------------------------------------------------
 * MARK VEHICLE AS SOLD
 * --------------------------------------------------
 *
 * The purchase and vehicle ownership state are updated
 * inside the SAME transaction.
 *
 * If anything fails after this point, the transaction
 * rolls back and the vehicle will not be incorrectly
 * marked as sold.
 */
const [vehicleUpdateResult] = await connection.query(
    `
    UPDATE vehicles
    SET
        sale_status = 'sold',
        sold_at = NOW(),
        sold_to = ?
    WHERE
        id = ?
        AND sale_status <> 'sold'
    `,
    [
        winnerId,
        currentAuction.vehicle_id
    ]
);

if (vehicleUpdateResult.affectedRows !== 1) {
    throw new Error(
        `Vehicle sale-state update failed for ${currentAuction.vehicle_id}`
    );
}

/*
 * --------------------------------------------------
 * FINALIZE AUCTION
 * --------------------------------------------------
 */
await connection.query(
    `
    UPDATE auctions
    SET
        status = 'ended',
        settlement_status = 'completed',
        settled_at = NOW(),
        settlement_reference = ?,
        payment_deadline = NULL
    WHERE id = ?
    `,
    [
        settlementReference,
        currentAuction.id
    ]
);

/*
 * --------------------------------------------------
 * COMMIT COMPLETE SETTLEMENT
 * --------------------------------------------------
 */
await connection.commit();

console.log(
    `[Auction Worker] Auction ${currentAuction.id} successfully settled. Vehicle ${currentAuction.vehicle_id} marked as sold.`
);

} 
catch (error) {
        if (connection) {
            try {
                await connection.rollback();
            } catch (rollbackError) {
                console.error(
                    "[Auction Worker] Rollback error:",
                    rollbackError
                );
            }
        }

        console.error(
            `[Auction Worker] Auction ${auction.id} settlement failed:`,
            error
        );
    } finally {
        if (connection) {
            connection.release();
        }
    }
};


/**
 * Start the background worker.
 *
 * Every 10 seconds is enough for a normal auction marketplace.
 */
const startAuctionSettlementWorker = () => {
    console.log(
        "[Auction Worker] Settlement worker started."
    );

    /*
     * Run once immediately instead of waiting 10 seconds.
     */
    processEndedAuctions();

    /*
     * Then continue checking periodically.
     */
    setInterval(
        processEndedAuctions,
        10 * 1000
    );
};


module.exports = {
    processEndedAuctions,
    startAuctionSettlementWorker
};