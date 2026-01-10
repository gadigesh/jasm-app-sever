const express = require("express");
const accountRouter = express.Router();
const Account = require("../models/account");
const { userAuth } = require("../middlewares/auth");

const normalize = (value) => value.trim().toLowerCase();

accountRouter.post("/accounts/create", userAuth, async (req, res) => {
	try {
		const { accountName, clientName, accountStatus } = req.body;

		if (!accountName || !clientName) {
			return res.status(400).json({
				message: "Account name and client are required",
			});
		}

		const normalAccountName = normalize(accountName);
		const normalClientName = normalize(clientName);

		// 🔍 Check existing account
		const existingAccount = await Account.findOne({
			accountName: normalAccountName,
			clientName: normalClientName,
		});

		if (existingAccount) {
			return res.status(409).json({
				message: "Account already exists",
			});
		}

		// Create & save
		const account = await Account.create({
			accountName: normalAccountName,
			clientName: normalClientName,
			accountStatus,
		});

		res.status(201).json({
			message: "Account created successfully",
			data: account,
		});
	} catch (err) {
		// Mongo duplicate key
		if (err.code === 11000) {
			return res.status(409).json({ message: "Account already exists" });
		}

		// Mongoose validation error
		if (err.name === "ValidationError") {
			// pick the first field with error safely
			const field = Object.keys(err.errors || {})[0];
			const message = field
				? `${field} should be either Active or Inactive`
				: err.message;
			return res.status(400).json({ message });
		}

		// fallback
		console.error(err); // log the real error for debugging
		return res.status(500).json({ message: "Failed to create account" });
	}
});

accountRouter.post("/switch-account", userAuth, async (req, res) => {
	const { accountId } = req.body;

	req.user.activeAccountId = accountId;
	await req.user.save();

	res.json({ message: "Active account updated" });
});

accountRouter.get("/accounts", userAuth, async (req, res) => {
	try {
		const { status } = req.query;
		const filter = {};

		if (status) {
			const VALID_STATUSES = ["Active", "Inactive"];
			const normalizedStatus =
				status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

			if (!VALID_STATUSES.includes(normalizedStatus)) {
				return res.status(400).json({
					message: `Invalid status filter. Allowed: ${VALID_STATUSES.join(
						", "
					)}`,
				});
			}

			filter.accountStatus = normalizedStatus;
		}

		const accounts = await Account.find(filter).sort({ updatedAt: -1 });

		res.status(200).json({
			message: "Accounts fetched successfully",
			data: accounts,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: "Failed to fetch accounts",
		});
	}
});

module.exports = accountRouter;
