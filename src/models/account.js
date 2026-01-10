const mongoose = require("mongoose");

const accountSchema = new mongoose.Schema(
	{
		accountName: {
			type: String,
			required: true,
			trim: true,
		},

		clientName: {
			type: String,
			required: true,
			trim: true,
		},

		accountStatus: {
			type: String,
			enum: ["Active", "Inactive"],
			default: "Active",
		},
	},
	{
		timestamps: true, // gives createdAt & updatedAt
	}
);


accountSchema.set("toJSON", {
	transform: (doc, ret) => {
		ret.id = ret._id;
		ret.lastUpdated = ret.updatedAt;
		delete ret._id;
		delete ret.__v;
		delete ret.createdAt;
		delete ret.updatedAt;
	},
});

accountSchema.index({ clientName: 1, accountName: 1 }, { unique: true });
module.exports = mongoose.model("Account", accountSchema);
