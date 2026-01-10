const express = require("express");
const authRouter = express.Router();
const User = require("../models/user");
const { validateSignUpdata } = require("../utils/validation");
const Account = require("../models/account");
const bcrypt = require("bcrypt");
const { userAuth } = require("../middlewares/auth");

authRouter.get("/me", userAuth, async (req, res) => {
	try {
		let activeAccount = null;

		if (req.user.activeAccountId) {
			activeAccount = await Account.findById(
				req.user.activeAccountId
			).lean();
		}

		res.json({
			_id: req.user._id,
			firstName: req.user.firstName,
			emailId: req.user.emailId,
			photoUrl: req.user.photoUrl,
			activeAccount,
		});
	} catch (error) {
		res.status(401).send(error.message + " please login");
	}
});
authRouter.post("/signup", async (req, res) => {
	try {
		validateSignUpdata(req);

		const { firstName, lastName, emailId, password, photoUrl } = req.body;
		const passwordHash = await bcrypt.hash(password, 10);

		// 1️⃣ Find or create default account FIRST
		let account = await Account.findOne({
			clientName: "Jivox",
			accountName: "Demo",
		});

		if (!account) {
			account = await Account.create({
				clientName: "Jivox",
				accountName: "Demo",
				accountStatus: "Active",
			});
		}

		// 2️⃣ Create user WITH correct activeAccountId
		const user = new User({
			firstName,
			lastName,
			emailId,
			password: passwordHash,
			photoUrl,
			activeAccountId: account._id, // ✅ CORRECT
		});

		const saveUser = await user.save();
		const token = await saveUser.getJWT();

		// ⚠️ LOCALHOST COOKIE SETTINGS
		res.cookie("token", token, {
			httpOnly: true,
			secure: false, // 🔥 MUST be false on localhost
			sameSite: "lax", // 🔥
			maxAge: 24 * 60 * 60 * 1000,
		});

		res.json({
			message: "User added successfully",
		});
	} catch (err) {
		res.status(401).json({ message: err.message });
	}
});

authRouter.post("/login", async (req, res) => {
	try {
		const { id, emailId, password } = req.body;
		const user = await User.findOne({ emailId: emailId });
		if (!emailId || !password) {
			return res.status(400).send("Email and password required");
		}
		if (!user) {
			throw new Error("email Id is not prsent in DB");
		}
		const isPasswordValid = await user.validatePassword(password);
		if (isPasswordValid) {
			const token = await user.getJWT();
			res.cookie("token", token, {
				httpOnly: true, // prevents JS from accessing cookie
				secure: true, // required over HTTPS
				sameSite: "lax", // allows cross-site cookies (Firebase frontend)
				maxAge: 24 * 60 * 60 * 1000, // 1 day
			});
			res.send(user);
		} else {
			throw new Error("Invalid credientials");
		}
	} catch (error) {
		res.status(401).send(error.message);
	}
});

authRouter.post("/logout", (req, res) => {
	res.cookie("token", "", {
		httpOnly: true,
		secure: true,
		sameSite: "none",
		expires: new Date(0),
	});
	res.json({
		message: "Logout successful",
	});
});
module.exports = authRouter;
