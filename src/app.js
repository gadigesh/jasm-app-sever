const express = require("express");
const connectDB = require("./config/database");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const app = express();
app.use(express.json());
app.use(cookieParser());

const allowedOrigins = ["http://localhost:5173"];

app.use(
	cors({
		origin: function (origin, callback) {
			if (!origin || allowedOrigins.includes(origin)) {
				callback(null, true);
			} else {
				callback(new Error("Not allowed by CORS"));
			}
		},
		credentials: true,
	})
);

const authRouter = require("./routes/auth");
const accountRouter = require("./routes/account");
const assetRouter = require("./routes/assetTemplate");
const assetUploadRouter = require("./routes/assetUpload");
const copyMatrixRouter = require("./routes/copyMatrix");

app.use("/", authRouter);
app.use("/", accountRouter);
app.use("/", assetRouter);
app.use("/", assetUploadRouter);
app.use("/", copyMatrixRouter);

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
