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

// Function to send password reset email
const sendPasswordResetEmail = async (email, resetLink) => {
    try {
        await transporter.sendMail({
            from: `"Bid My Car" <${process.env.EMAIL_USER}>`,
            to: email,
            subject: "Reset your Bid My Car password",

            html: `
                <html>
                    <body style="
                        font-family: Arial, sans-serif;
                        line-height: 1.6;
                        color: #222;
                    ">

                        <h2>Reset Your Bid My Car Password</h2>

                        <p>
                            We received a request to reset the password
                            for your Bid My Car account.
                        </p>

                        <p>
                            Click the button below to create a new password:
                        </p>

                        <p>
                            <a href="${resetLink}"
                               style="
                               display:inline-block;
                               padding:12px 24px;
                               background:#000;
                               color:#fff;
                               text-decoration:none;
                               border-radius:5px;
                               font-weight:bold;">
                                Reset Password
                            </a>
                        </p>

                        <p>
                            This password reset link will expire after
                            <strong>1 hour</strong>.
                        </p>

                        <p>
                            If you did not request a password reset,
                            you can safely ignore this email.
                        </p>

                        <p>
                            — Bid My Car
                        </p>

                    </body>
                </html>
            `
        });

        console.log(`Password reset email sent to ${email}`);

    } catch (error) {
        console.error("Password reset email error:", error);
        throw error;
    }
};

module.exports = sendPasswordResetEmail;