const express = require("express");
require("dotenv").config();
const app = express();
const connectDB = require("./config/database");
const User = require("./models/user");

app.use(express.json());

app.post("/signup", async (req, res) => {
	try {
		console.log(req.body);
		// const user = new User({
		// 	name: "Gadigesh",
		// 	email: "gadigesh@gmail.com",
		// 	password: "123456",
		// });
		await user.save();
		res.status(201).json({
			message: "User created successfully",
			Data: user,
		});
	} catch (error) {
		res.status(500).json({ error: error.message });
	}
});

connectDB()
	.then(() => {
		app.listen(3333, () => {
			console.log("Server is running on port 3333");
		});
	})
	.catch((error) => {
		console.error("Failed to connect to MongoDB:", error);
		process.exit(1);
	});
	
