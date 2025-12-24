const jwt = require("jsonwebtoken");
const User = require("../models/user");
const userAuth = async (req, res, next) => {
	//Read the token from the req and validate the token find the user
	try {
		const cookie = req.cookies;
		const { token } = cookie;
		if (!token) {
			return res.status(401).send("Please Login");
		}
		const deCodedObj = jwt.verify(token, process.env.TOKEN_SECRETE_KEY);
		const { _id } = deCodedObj;
		const user = await User.findById(_id);
		if (!user) {
			throw new Error("User Not found");
		}
		req.user = user;
		next();
	} catch (error) {
		res.status(401).send("Error: " + error.message);
	}
};

module.exports = {
	userAuth,
};
