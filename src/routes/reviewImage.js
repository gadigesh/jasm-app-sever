const express = require("express");
const { userAuth } = require("../middlewares/auth");
const { fetchReviewImage } = require("../utils/fetchReviewImage");

const reviewImageRouter = express.Router();

reviewImageRouter.get("/review-image", userAuth, async (req, res) => {
	try {
		const image = await fetchReviewImage(req.query.url);
		res.set("Content-Type", image.contentType);
		res.set("Cache-Control", "private, max-age=120");
		res.send(image.buffer);
	} catch (error) {
		res.status(error.statusCode || 400).json({
			message: error.message || "Unable to load image",
		});
	}
});

module.exports = reviewImageRouter;
