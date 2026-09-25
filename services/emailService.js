const nodemailer = require("nodemailer");
const dotenv = require("dotenv");

dotenv.config();

// Create email transporter
const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

// Function to send verification email
const sendVerificationEmail = async (email, verificationLink) => {
    try {
        await transporter.sendMail({
            from: `"Bid My Car" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Verify your Bid My Car account",
            html: `
                <h2>Welcome to Bid My Car!</h2>

                <p>Thank you for registering.</p>

                <p>
                    Please click the button below to verify your email address:
                </p>

                <p>
                    <a href="${verificationLink}"
                       style="
                       display:inline-block;
                       padding:10px 20px;
                       background:#000;
                       color:#fff;
                       text-decoration:none;
                       border-radius:5px;">
                        Verify Email
                    </a>
                </p>

                <p>
                    This verification link will expire after 24 hours.
                </p>

                <p>
                    If you did not create this account, you can ignore this email.
                </p>

                <p>— Bid My Car</p>
            `
        });

        console.log(`Verification email sent to ${email}`);

    } catch (error) {
        console.error("Email sending error:", error);
        throw error;
    }
};

module.exports = sendVerificationEmail;