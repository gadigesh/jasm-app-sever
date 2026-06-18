const jwt = require("jsonwebtoken");
const User = require("../models/user");
require("dotenv").config();

const userAuth = async (req, res, next) => {
	try {
		// 1. Get Token (From Cookie OR Header)
		let token = req.cookies?.token;
		const authHeader = req.header("Authorization");

		if (!token && authHeader && authHeader.startsWith("Bearer ")) {
			token = authHeader.replace("Bearer ", "");
		}

		if (!token) {
			return res.status(401).send("Access Denied: Please Login");
		}

		// 🟢 2. CHECK SYSTEM KEY FIRST (CRITICAL FIX)
		// We must check this BEFORE jwt.verify, because the API Key is not a JWT.
		// if (
		// 	process.env.SYSTEM_API_KEY &&
		// 	token === process.env.SYSTEM_API_KEY
		// ) {
		// 	// Mock a user object so controllers don't crash
		// 	req.user = {
		// 		_id: null,
		// 		firstName: "System",
		// 		lastName: "Sync",
		// 	};
		// 	return next(); // ✅ Exit here successfully
		// }

		// 🔵 3. VERIFY JWT (Only if it wasn't the System Key)
		const deCodedObj = jwt.verify(token, process.env.TOKEN_SECRETE_KEY);
		const { _id } = deCodedObj;
		const user = await User.findById(_id);

		if (!user) {
			throw new Error("User Not found");
		}

		req.user = user;
		next();
	} catch (error) {
		// This is where "jwt malformed" was coming from
		console.error("Auth Error:", error.message);
		res.status(401).send("Error: " + error.message);
	}
};

module.exports = {
	userAuth,
};
