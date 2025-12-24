const express = require("express");
const authRouter = express.Router();
const User = require("../models/user");
const { validateSignUpdata } = require("../utils/validation");
const bcrypt = require("bcrypt");

authRouter.post("/signup", async (req, res) => {
	try {
		validateSignUpdata(req);
		const { firstName, lastName, emailId, password, photoUrl } = req.body;
		const passwordHash = await bcrypt.hash(password, 10);
		const user = new User({
			firstName,
			lastName,
			emailId,
			password: passwordHash,
			photoUrl,
		});

		const saveUser = await user.save();
		const token = await saveUser.getJWT();

		res.cookie("token", token);
		res.json({
			message: "User added successfully",
			data: saveUser,
		});
	} catch (err) {
		res.status(401).send(err.message);
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
			res.cookie("token", token);
			res.send(user);
		} else {
			throw new Error("Invalid credientials");
		}
	} catch (error) {
		res.status(401).send(error.message);
	}
});
authRouter.post("/logout", (req, res) => {
	res.cookie("token", null, {
		expires: new Date(Date.now()),
	});
	res.send("Logout successful");
});
module.exports = authRouter;
