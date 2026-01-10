const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
require("dotenv").config();
const userSchema = new mongoose.Schema(
	{
		firstName: {
			type: String,
			required: true,
			index: true,
		},
		lastName: {
			type: String,
		},
		emailId: {
			type: String,
			required: true,
			unique: true,
			trim: true,
			lowercase: true,
		},
		password: {
			type: String,
			required: true,
		},
		photoUrl: {
			type: String,
			default: "https://cdn.jivox.com/files/57886/user.png",
			match: [/^(https):\/\//, "URL must include https"],
		},
		activeAccountId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Account",
			default: null,
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
	},
	{ timestamps: true }
);
userSchema.methods.getJWT = async function () {
	const user = this;
	const token = await jwt.sign(
		{ _id: user._id },
		process.env.TOKEN_SECRETE_KEY
	);
	return token;
};
userSchema.methods.validatePassword = async function (passwordByUser) {
	const user = this;
	const isPasswordValid = await bcrypt.compare(passwordByUser, user.password);
	return isPasswordValid;
};
module.exports = mongoose.model("User", userSchema);
