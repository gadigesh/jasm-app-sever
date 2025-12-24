require("dotenv").config();
const mongoose = require("mongoose");

const run = async () => {
	try {
        console.log("Connecting to MongoDB...");
		await mongoose.connect(
			`${process.env.MONGO_URI}/${process.env.DB_NAME}`
		);
		console.log("Connected to MongoDB");
        
        // Check if index exists before dropping to avoid error (optional, but dropIndex throws if not found usually)
		await mongoose.connection.collection("users").dropIndex("email_1");
		console.log("Index 'email_1' dropped successfully");
		process.exit(0);
	} catch (error) {
        if (error.codeName === 'IndexNotFound') {
            console.log("Index 'email_1' not found. It might have been already dropped.");
            process.exit(0);
        }
		console.error("Error dropping index:", error.message);
		process.exit(1);
	}
};

run();
