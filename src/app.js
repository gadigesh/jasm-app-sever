const express = require("express");
const connectDB = require("./config/database");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const app = express();
// Column operations send sparse local overrides. Keep a bounded fallback above
// Express's 100 KB default without allowing unbounded request bodies.
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

const allowedOrigins = new Set(
	[
		"http://localhost:5173",
		"http://localhost:4173",
		"https://localhost:5173",
		"https://localhost:4173",
		"http://127.0.0.1:5173",
		"http://127.0.0.1:4173",
		"https://127.0.0.1:5173",
		"https://127.0.0.1:4173",
		process.env.FRONTEND_APP_URL,
	].filter(Boolean)
);

function isLocalDevOrigin(origin) {
	try {
		const url = new URL(origin);
		return (
			(url.protocol === "http:" || url.protocol === "https:") &&
			(url.hostname === "localhost" || url.hostname === "127.0.0.1")
		);
	} catch {
		return false;
	}
}

app.use(
	cors({
		origin: function (origin, callback) {
			if (!origin || allowedOrigins.has(origin) || isLocalDevOrigin(origin)) {
				callback(null, true);
			} else {
				callback(null, false);
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
