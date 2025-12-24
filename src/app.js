const express = require("express");
const connectDB = require("./config/database");
const cookiePaser = require("cookie-parser");
const cors = require("cors");
const app = express();

app.use(express.json());
app.use(cookiePaser());
app.use(
	cors({
		origin: "http://localhost:5174",
		credentials: true,
	})
);
const authRouter = require("./routes/auth");
app.use("/", authRouter);

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
