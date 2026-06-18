const mongoose = require("mongoose");
require("dotenv").config();

const connectDB = async () => {
	try {
		const mongoUri = process.env.MONGO_URI.replace(/\/+$/, "");
		await mongoose.connect(`${mongoUri}/${process.env.DB_NAME}`);
		console.log("MongoDB connected");
	} catch (error) {
		console.error("MongoDB connection failed:", error.message);
		process.exit(1);
	}
};

module.exports = connectDB;
