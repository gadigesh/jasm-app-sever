const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mongoose = require("mongoose");

// Models & Services
const AssetUpload = require("../models/assetUpload");
const AssetSource = require("../models/assetSource");
const CopyMatrix = require("../models/copyMatrix");
const storageService = require("../services/storage");
const { processUpload } = require("../services/processors");
const { updateAssetWithHistory } = require("../services/assetServices");
const { userAuth } = require("../middlewares/auth");
const { buildCsv, sendCsv } = require("../utils/csvExport");
const {
	assertUniqueAssetSourceName,
	checkAssetSourceNameAvailability,
	getDeletedAssetSourceNames,
	isDuplicateNameError,
} = require("../utils/nameValidation");
const { formatApiError } = require("../utils/apiErrors");
const {
	AUTO_ROW_ID_COLUMN,
	isAutoRowIdColumn,
	normalizeRowDataValues,
	normalizeCellText,
} = require("../constants/copyMatrix");
const {
	fillColumnSequence,
	copyFromOtherColumn,
	deleteAssetSourceRow,
	generateColumnText,
	fillColumnDate,
	replaceInColumn,
	applyColumnCellChanges,
	renameAssetSourceColumn,
	deleteAssetSourceColumn,
	cloneAssetSourceColumn,
	suggestCloneColumnName,
	reorderAssetSourceColumns,
	addAssetSourceRow,
	addAssetSourceColumn,
	cloneAssetSourceRow,
	updateColumnImages,
	fillColumnWithCdnUrl,
} = require("../services/assetSourceColumnOps");
const {
	uploadAssetsToAccount,
	listAccountFolders,
	resolveUploadedCdnUrl,
} = require("../services/mindshareAssetLibrary");

const assetRouter = express.Router();

async function analyzeAssetSourceUniqueness(
	uploadId,
	keyColumn,
	rowUpdates = []
) {
	if (isAutoRowIdColumn(keyColumn)) {
		return {
			unique: true,
			column: keyColumn,
			duplicates: [],
			emptyRowIndexes: [],
			emptyRowIds: [],
			message: null,
		};
	}

	const rows = await AssetSource.find({
		uploadId,
		isDeleted: false,
	})
		.select("_id rowData cmRowIndex")
		.sort({ cmRowIndex: 1, primaryKey: 1 })
		.lean();
	const updatesById = new Map(
		(Array.isArray(rowUpdates) ? rowUpdates : [])
			.filter((item) => item?._id && item?.rowData)
			.map((item) => [String(item._id), item.rowData])
	);
	const byValue = new Map();
	const emptyRows = [];

	rows.forEach((row, index) => {
		const rowData = {
			...(row.rowData || {}),
			...(updatesById.get(String(row._id)) || {}),
		};
		const value = normalizeCellText(rowData[keyColumn]);
		const rowIndex = row.cmRowIndex ?? index + 1;
		const entry = { rowId: String(row._id), rowIndex };
		if (!value) {
			emptyRows.push(entry);
			return;
		}
		if (!byValue.has(value)) byValue.set(value, []);
		byValue.get(value).push(entry);
	});

	const duplicates = Array.from(byValue.entries())
		.filter(([, matchingRows]) => matchingRows.length > 1)
		.map(([value, matchingRows]) => ({
			value,
			count: matchingRows.length,
			rowIndexes: matchingRows.map((row) => row.rowIndex),
			rowIds: matchingRows.map((row) => row.rowId),
		}));
	const emptyRowIndexes = emptyRows.map((row) => row.rowIndex);
	const emptyRowIds = emptyRows.map((row) => row.rowId);
	const unique = duplicates.length === 0 && emptyRows.length === 0;
	let message = null;

	if (duplicates.length > 0) {
		const samples = duplicates
			.slice(0, 3)
			.map(
				(item) =>
					`"${item.value}" (rows ${item.rowIndexes.join(", ")})`
			)
			.join("; ");
		message = `Duplicate values in "${keyColumn}": ${samples}${
			duplicates.length > 3
				? ` and ${duplicates.length - 3} more`
				: ""
		}`;
		if (emptyRows.length > 0) {
			message += `. Also ${emptyRows.length} empty cell${
				emptyRows.length === 1 ? "" : "s"
			}`;
		}
	} else if (emptyRows.length > 0) {
		message = `${emptyRows.length} empty cell${
			emptyRows.length === 1 ? "" : "s"
		} in "${keyColumn}". Fill every value before saving`;
	}

	return {
		unique,
		column: keyColumn,
		duplicates,
		emptyRowIndexes,
		emptyRowIds,
		message,
	};
}

// Multer Config (Temp Storage)
const upload = multer({
	dest: "temp_uploads/",
	limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});

function parseCopyMatrixIdFromFileRef(fileRef) {
	const match = String(fileRef || "").match(/^copy-matrix:\/\/(.+)$/);
	return match?.[1] || null;
}

function collectMatrixIdsForAsset(asset) {
	const ids = new Set();
	if (asset.copyMatrixId) {
		ids.add(String(asset.copyMatrixId));
	}
	const fromFileRef = parseCopyMatrixIdFromFileRef(asset.fileRef);
	if (fromFileRef) {
		ids.add(fromFileRef);
	}
	return [...ids];
}

// Latest unfinished draft for an account (Back/Cancel save-as-draft resume).
assetRouter.get("/source/draft/:accountId", userAuth, async (req, res) => {
	try {
		const { accountId } = req.params;
		const draft = await AssetUpload.findOne({
			accountId,
			$or: [{ status: "draft" }, { hasEditDraft: true }],
		})
			.select("_id assetName name fileName status hasEditDraft updatedAt")
			.sort({ updatedAt: -1 })
			.lean();

		res.status(200).json({
			message: draft ? "Draft found" : "No draft",
			data: draft
				? {
						_id: String(draft._id),
						name:
							draft.assetName ||
							draft.name ||
							draft.fileName?.replace(/\.[^.]+$/, "") ||
							"Untitled",
						status: draft.status,
						hasEditDraft: Boolean(draft.hasEditDraft),
						updatedAt: draft.updatedAt,
				  }
				: null,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: err.message || "Failed to fetch draft",
		});
	}
});

assetRouter.post("/source/:id/save-draft", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		if (upload.status !== "draft") {
			upload.hasEditDraft = true;
		}
		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({
			message: "Saved as draft",
			data: {
				_id: String(upload._id),
				name: upload.assetName,
				status: upload.status,
				hasEditDraft: Boolean(upload.hasEditDraft),
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: err.message || "Failed to save draft",
		});
	}
});

assetRouter.post("/source/:id/discard-draft", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		if (upload.status === "draft") {
			await AssetSource.deleteMany({ uploadId: upload._id });
			await upload.deleteOne();
			return res.status(200).json({
				message: "Draft discarded",
				data: { deleted: true },
			});
		}

		upload.hasEditDraft = false;
		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({
			message: "Draft discarded",
			data: {
				deleted: false,
				_id: String(upload._id),
				status: upload.status,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: err.message || "Failed to discard draft",
		});
	}
});

// =====================================================================
// ROUTE 1: GET ASSET LIST
// Usage: When user clicks an Account Card (e.g., Nike)
// URL: GET /api/assets/list/:accountId
// =====================================================================
assetRouter.get("/list/:accountId", userAuth, async (req, res) => {
	try {
		const { accountId } = req.params;

		// Fetch uploads linked to this specific Account (exclude drafts)
		const assets = await AssetUpload.find({
			accountId,
			status: { $ne: "draft" },
		})
			.populate("uploadedBy", "firstName lastName email")
			.sort({ updatedAt: -1 })
			.lean();

		const uploadIds = assets.map((asset) => asset._id);
		const copyMatrixIds = [
			...new Set(assets.flatMap((asset) => collectMatrixIdsForAsset(asset))),
		];

		const matricesById = new Map();
		const matricesByUploadId = new Map();

		if (copyMatrixIds.length > 0) {
			const objectIds = copyMatrixIds
				.filter((id) => mongoose.Types.ObjectId.isValid(id))
				.map((id) => new mongoose.Types.ObjectId(id));

			const byId = await CopyMatrix.find({
				_id: { $in: objectIds },
				accountId,
			})
				.select("_id name status")
				.lean();

			for (const matrix of byId) {
				matricesById.set(String(matrix._id), {
					id: String(matrix._id),
					name: matrix.name,
					status: matrix.status,
				});
			}
		}

		if (uploadIds.length > 0) {
			const byUpload = await CopyMatrix.find({
				assetUploadId: { $in: uploadIds },
				accountId,
			})
				.select("_id name status assetUploadId")
				.lean();

			for (const matrix of byUpload) {
				matricesByUploadId.set(String(matrix.assetUploadId), {
					id: String(matrix._id),
					name: matrix.name,
					status: matrix.status,
				});
			}
		}

		const formattedData = assets.map((asset) => {
			const userName = asset.uploadedBy
				? asset.uploadedBy.firstName
				: "Unknown";

			const mappedCopyMatrices = [];
			const seenMatrixIds = new Set();

			const addMatrix = (matrix) => {
				if (!matrix?.id || seenMatrixIds.has(matrix.id)) return;
				seenMatrixIds.add(matrix.id);
				mappedCopyMatrices.push(matrix);
			};

			if (asset.copyMatrixId) {
				addMatrix(matricesById.get(String(asset.copyMatrixId)));
			}

			const fileRefMatrixId = parseCopyMatrixIdFromFileRef(asset.fileRef);
			if (fileRefMatrixId) {
				addMatrix(matricesById.get(fileRefMatrixId));
			}

			addMatrix(matricesByUploadId.get(String(asset._id)));

			const mappedCopyMatrix = mappedCopyMatrices[0] || null;

			return {
				_id: asset._id,
				name: asset.assetName,
				fileName: asset.fileName,
				status: asset.status,
				rows: asset.processedRows,
				uploadedBy: userName,
				updatedBy: userName,
				updatedAt: asset.updatedAt,
				copyMatrixId: asset.copyMatrixId
					? String(asset.copyMatrixId)
					: null,
				mappedCopyMatrix,
				mappedCopyMatrices,
			};
		});

		res.status(200).json({
			message: "Assets fetched successfully",
			data: formattedData,
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch asset list" });
	}
});

// =====================================================================
// ROUTE 2: UPLOAD NEW ASSET
// Usage: When user clicks "Add New" inside the Account View
// URL: POST /api/assets/upload
// =====================================================================
assetRouter.post(
	"/upload",
	userAuth,
	upload.single("file"),
	async (req, res) => {
		// Cleanup helper in case of error (safely unlinking only if temp file still exists)
		const cleanup = () => {
			try {
				if (req.file && fs.existsSync(req.file.path)) {
					fs.unlinkSync(req.file.path);
				}
			} catch (err) {
				console.error("Cleanup error:", err);
			}
		};

		try {
			// 1. Extract Data from Frontend Form
			const { accountId, assetName, uniqueColumn, inputType, fileRef } =
				req.body;
			const isGSheet = inputType === "gsheet";

			// 2. Validation
			if (!isGSheet && !req.file) {
				return res.status(400).json({ message: "No file uploaded" });
			}
			if (isGSheet && !fileRef) {
				return res
					.status(400)
					.json({ message: "Google Sheet ID (fileRef) is required" });
			}
			if (!accountId) {
				cleanup();
				return res
					.status(400)
					.json({ message: "Account ID is required" });
			}
			if (!uniqueColumn) {
				cleanup();
				return res.status(400).json({
					message: "Unique Column (Primary Key) is required",
				});
			}

			let finalFileRef = isGSheet ? fileRef.trim() : "";
			let fileHash = "";
			let fileName = "";
			let fileType = "";

			if (!isGSheet) {
				// Compute MD5 hash of the uploaded file
				const fileBuffer = fs.readFileSync(req.file.path);
				fileHash = crypto
					.createHash("md5")
					.update(fileBuffer)
					.digest("hex");

				// Move file to permanent storage and get the final reference path
				finalFileRef = await storageService.saveFile(req.file);

				fileName = req.file.originalname;
				fileType = path
					.extname(req.file.originalname)
					.replace(".", "")
					.toLowerCase();
			} else {
				// For Google Sheets, generate a unique hash based on spreadsheetId and current timestamp
				fileHash = crypto
					.createHash("md5")
					.update(fileRef.trim() + "_" + Date.now())
					.digest("hex");
				fileName = assetName || "Google Sheet";
				fileType = "GSheet";
			}

			const resolvedAssetName = (
				assetName?.trim() ||
				fileName.replace(/\.[^.]+$/, "") ||
				fileName
			).trim();

			if (!resolvedAssetName) {
				cleanup();
				return res.status(400).json({
					message: "Asset source name is required",
				});
			}

			await assertUniqueAssetSourceName(accountId, resolvedAssetName);

			// 3. Create the Database Record (Pending Status)
			const newUpload = await AssetUpload.create({
				accountId: accountId, // 🔗 LINK TO ACCOUNT
				assetName: resolvedAssetName,
				uniqueColumn: uniqueColumn.trim(), // 🔑 The column selected by user
				fileName,
				inputType: inputType || "file",
				fileType,
				fileRef: finalFileRef,
				status: "pending",
				fileHash,
				uploadedBy: req.user._id, // From userAuth middleware
			});

			// 4. Trigger Processing (Awaited to capture actual processing result)
			await processUpload(newUpload._id);

			// Fetch the updated document to check the status
			const finalUpload = await AssetUpload.findById(newUpload._id);

			if (!finalUpload || finalUpload.status === "failed") {
				return res.status(500).json({
					message:
						finalUpload?.message ||
						"Could not process the file. Check the format and try again.",
				});
			}

			// 5. Respond to UI with final state
			res.status(201).json({
				message: finalUpload.message || "Upload completed successfully",
				data: {
					uploadId: newUpload._id,
					status: finalUpload.status,
					processedRows: finalUpload.processedRows,
					validationErrors: finalUpload.validationErrors,
				},
			});
		} catch (err) {
			cleanup();
			console.error("Upload Error:", err);
			if (isDuplicateNameError(err)) {
				return res.status(409).json({ message: err.message });
			}
			res.status(500).json({
				message:
					err.message ||
					"File upload failed. Please check your file and try again.",
			});
		}
	},
);

// =====================================================================
// ROUTE 3: RETRY / REPLACE UPLOAD FILE
// Usage: When user replaces the spreadsheet for an existing upload record
// URL: PUT /retry/:id
// =====================================================================
assetRouter.put(
	"/retry/:id",
	userAuth,
	upload.single("file"),
	async (req, res) => {
		const cleanup = () => {
			try {
				if (req.file && fs.existsSync(req.file.path)) {
					fs.unlinkSync(req.file.path);
				}
			} catch (err) {
				console.error("Cleanup error:", err);
			}
		};

		try {
			const { id } = req.params;
			if (!req.file) {
				return res.status(400).json({ message: "No file uploaded" });
			}

			const assetUpload = await AssetUpload.findById(id);
			if (!assetUpload) {
				cleanup();
				return res
					.status(404)
					.json({ message: "Asset upload record not found" });
			}

			// Compute MD5 hash of the uploaded file
			const fileBuffer = fs.readFileSync(req.file.path);
			const fileHash = crypto
				.createHash("md5")
				.update(fileBuffer)
				.digest("hex");

			// Move file to permanent storage and get the final reference path
			const finalFileRef = await storageService.saveFile(req.file);

			const fileName = req.file.originalname;
			const fileType = path
				.extname(req.file.originalname)
				.replace(".", "")
				.toLowerCase();

			// Update the Database Record (Pending Status)
			assetUpload.fileName = fileName;
			assetUpload.fileType = fileType;
			assetUpload.fileRef = finalFileRef;
			assetUpload.status = "pending";
			assetUpload.fileHash = fileHash;
			assetUpload.uploadedBy = req.user._id;

			await assetUpload.save();

			// Trigger Processing (Awaited to capture actual processing result)
			await processUpload(assetUpload._id);

			// Fetch the updated document to check the status
			const finalUpload = await AssetUpload.findById(assetUpload._id);

			if (!finalUpload || finalUpload.status === "failed") {
				return res.status(500).json({
					message:
						finalUpload?.message ||
						"Could not process the file. Check the format and try again.",
				});
			}

			// Respond to UI with final state
			res.status(200).json({
				message:
					finalUpload.message ||
					"Upload updated and processed successfully",
				data: {
					uploadId: assetUpload._id,
					status: finalUpload.status,
					processedRows: finalUpload.processedRows,
					validationErrors: finalUpload.validationErrors,
				},
			});
		} catch (err) {
			cleanup();
			console.error("Retry Upload Error:", err);
			res.status(500).json({
				message:
					err.message ||
					"File update failed. Please check your file and try again.",
			});
		}
	},
);

assetRouter.get(
	"/source/check-name/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;
			const { name, excludeId } = req.query;

			const result = await checkAssetSourceNameAvailability(
				accountId,
				name,
				excludeId || null
			);

			res.status(200).json({
				message: result.available
					? "Name is available"
					: result.message,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to check asset source name" });
		}
	}
);

// =====================================================================
// ROUTE 4b: UPDATE ASSET SOURCE METADATA (draft name)
// URL: PUT /source/:id
// =====================================================================
assetRouter.put("/source/:id", userAuth, async (req, res) => {
	try {
		const { assetName } = req.body;
		const upload = await AssetUpload.findById(req.params.id);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}
		if (upload.status !== "draft") {
			return res.status(400).json({
				message: "Asset source name can only be set while in draft",
			});
		}
		if (!assetName?.trim()) {
			return res
				.status(400)
				.json({ message: "Asset source name is required" });
		}

		await assertUniqueAssetSourceName(
			upload.accountId,
			assetName.trim(),
			upload._id
		);

		upload.assetName = assetName.trim();
		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({
			message: "Asset source name saved",
			data: {
				_id: upload._id,
				name: upload.assetName,
				status: upload.status,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update asset source"),
		});
	}
});

assetRouter.get("/source/:id/export", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const sortOrder = { cmRowIndex: 1, primaryKey: 1 };

		const rows = await AssetSource.find({
			uploadId: upload._id,
			isDeleted: false,
		})
			.sort(sortOrder)
			.lean();

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: rows[0]?.rowData
				? Object.keys(rows[0].rowData)
				: [];

		const dataRows = rows.map((row) => row.rowData || {});
		const csv = buildCsv(columns, dataRows);
		sendCsv(
			res,
			upload.assetName || upload.fileName || "asset-source",
			csv
		);
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to export asset source" });
	}
});

// =====================================================================
// ROUTE 4: GET ASSET SOURCE DETAIL (draft or completed)
// URL: GET /source/:id
// =====================================================================
assetRouter.get("/source/:id", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id).populate(
			"uploadedBy",
			"firstName lastName email"
		);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: await AssetSource.findOne({ uploadId: upload._id }).then(
						(row) =>
							row?.rowData
								? Object.keys(row.rowData)
								: []
				  );

		let deletedAssetSourceNames = [];
		let syncedColumns = [];
		let copyMatrixName = "";
		if (upload.copyMatrixId) {
			const linkedMatrix = await CopyMatrix.findById(
				upload.copyMatrixId
			).select(
				"name columns deletedAssetSourceNames lastDeletedAssetSourceName"
			);
			syncedColumns = linkedMatrix?.columns || [];
			copyMatrixName = linkedMatrix?.name || "";
			deletedAssetSourceNames = getDeletedAssetSourceNames(linkedMatrix);
		}

		res.status(200).json({
			message: "Asset source fetched successfully",
			data: {
				_id: upload._id,
				accountId: upload.accountId,
				name: upload.assetName,
				fileName: upload.fileName,
				status: upload.status,
				uniqueColumn: upload.uniqueColumn,
				columns,
				processedRows: upload.processedRows,
				copyMatrixId: upload.copyMatrixId,
				copyMatrixName,
				syncedColumns,
				deletedAssetSourceNames,
				lastDeletedAssetSourceName:
					deletedAssetSourceNames[deletedAssetSourceNames.length - 1] ||
					null,
				updatedBy: upload.uploadedBy
					? upload.uploadedBy.firstName
					: "Unknown",
				updatedAt: upload.updatedAt,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch asset source" });
	}
});

// =====================================================================
// ROUTE 5: GET ASSET SOURCE ROWS (paginated)
// URL: GET /source/:id/rows
// =====================================================================
assetRouter.get("/source/:id/rows", userAuth, async (req, res) => {
	try {
		const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
		const limit = Math.min(
			Math.max(parseInt(req.query.limit, 10) || 50, 1),
			200
		);
		const skip = (page - 1) * limit;

		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const filter = { uploadId: upload._id, isDeleted: false };

		const sortOrder = { cmRowIndex: 1, primaryKey: 1 };

		const [rows, total] = await Promise.all([
			AssetSource.find(filter).sort(sortOrder).skip(skip).limit(limit).lean(),
			AssetSource.countDocuments(filter),
		]);

		const columns =
			upload.columns?.length > 0
				? upload.columns
				: rows[0]?.rowData
				? Object.keys(rows[0].rowData)
				: [];

		res.status(200).json({
			message: "Rows fetched successfully",
			data: {
				columns,
				rows: rows.map((row, idx) => ({
					_id: row._id,
					rowIndex: row.cmRowIndex ?? skip + idx + 1,
					primaryKey: row.primaryKey,
					...normalizeRowDataValues(row.rowData || {}),
				})),
				pagination: {
					page,
					limit,
					total,
					totalPages: Math.ceil(total / limit) || 1,
				},
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch rows" });
	}
});

// =====================================================================
// ROUTE 6: UPDATE ASSET SOURCE ROWS (bulk edit in preview)
// URL: PUT /source/:id/rows
// =====================================================================
assetRouter.post(
	"/source/:id/check-unique-column",
	userAuth,
	async (req, res) => {
		try {
			const upload = await AssetUpload.findById(req.params.id);
			if (!upload) {
				return res.status(404).json({ message: "Asset source not found" });
			}
			const column =
				req.body?.column?.trim() ||
				upload.uniqueColumn ||
				AUTO_ROW_ID_COLUMN;
			const analysis = await analyzeAssetSourceUniqueness(
				upload._id,
				column,
				req.body?.rows
			);
			res.status(200).json({
				message: analysis.unique
					? "Column is unique"
					: analysis.message,
				data: analysis,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: formatApiError(
					err,
					"Failed to check unique column"
				),
			});
		}
	}
);

assetRouter.put("/source/:id/rows", userAuth, async (req, res) => {
	try {
		const { rows } = req.body;
		if (!Array.isArray(rows) || rows.length === 0) {
			return res.status(400).json({ message: "Rows array is required" });
		}

		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		const keyColumn = upload.uniqueColumn;
		const uniqueness = await analyzeAssetSourceUniqueness(
			upload._id,
			keyColumn || AUTO_ROW_ID_COLUMN,
			rows
		);
		if (!uniqueness.unique) {
			return res.status(409).json({
				message: uniqueness.message,
				code: "UNIQUE_COLUMN_INVALID",
				data: uniqueness,
			});
		}

		for (const item of rows) {
			if (!item._id || !item.rowData) continue;

			const asset = await AssetSource.findById(item._id);
			if (!asset || String(asset.uploadId) !== String(upload._id)) continue;

			const normalizedRowData = normalizeRowDataValues(item.rowData);
			await updateAssetWithHistory(
				asset._id,
				normalizedRowData,
				req.user._id
			);
			if (normalizedRowData[keyColumn] != null) {
				await AssetSource.updateOne(
					{ _id: asset._id },
					{
						$set: {
							primaryKey: normalizeCellText(
								normalizedRowData[keyColumn]
							),
						},
					}
				);
			}
		}

		upload.uploadedBy = req.user._id;
		await upload.save();

		res.status(200).json({ message: "Rows updated successfully" });
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update rows"),
		});
	}
});

// =====================================================================
// ROUTE 7: FINISH ASSET SOURCE DRAFT
// URL: POST /source/:id/finish
// =====================================================================
assetRouter.post("/source/:id/finish", userAuth, async (req, res) => {
	try {
		const { assetName } = req.body;
		const upload = await AssetUpload.findById(req.params.id);

		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}
		if (upload.status !== "draft") {
			return res
				.status(400)
				.json({ message: "Only draft asset sources can be finalized" });
		}
		const uniqueness = await analyzeAssetSourceUniqueness(
			upload._id,
			upload.uniqueColumn || AUTO_ROW_ID_COLUMN
		);
		if (!uniqueness.unique) {
			return res.status(409).json({
				message: uniqueness.message,
				code: "UNIQUE_COLUMN_INVALID",
				data: uniqueness,
			});
		}

		if (assetName?.trim()) {
			const trimmedName = assetName.trim();
			await assertUniqueAssetSourceName(
				upload.accountId,
				trimmedName,
				upload._id,
				upload.copyMatrixId
			);
			upload.assetName = trimmedName;
		} else if (!upload.assetName?.trim()) {
			return res
				.status(400)
				.json({ message: "Asset source name is required" });
		} else {
			await assertUniqueAssetSourceName(
				upload.accountId,
				upload.assetName,
				upload._id,
				upload.copyMatrixId
			);
		}
		upload.status = "completed";
		upload.hasEditDraft = false;
		upload.message = `Asset source saved — ${upload.processedRows} rows`;
		upload.uploadedBy = req.user._id;
		await upload.save();

		await AssetSource.updateMany(
			{ uploadId: upload._id },
			{ $set: { importStatus: "ACTIVE" } }
		);

		res.status(200).json({
			message: "Asset source saved successfully",
			data: {
				uploadId: upload._id,
				name: upload.assetName,
				status: upload.status,
				processedRows: upload.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to save asset source"),
		});
	}
});

assetRouter.post("/source/:id/clone", userAuth, async (req, res) => {
	try {
		const { name, assetName } = req.body;
		const trimmedName = String(name || assetName || "").trim();

		if (!trimmedName) {
			return res.status(400).json({ message: "Asset source name is required" });
		}

		const source = await AssetUpload.findById(req.params.id);
		if (!source) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		await assertUniqueAssetSourceName(
			source.accountId,
			trimmedName
		);

		const sourceRows = await AssetSource.find({
			uploadId: source._id,
			isDeleted: false,
		}).lean();

		const fileRef =
			source.fileRef ||
			(source.copyMatrixId
				? `copy-matrix://${source.copyMatrixId}`
				: `asset-source://${source._id}`);

		let cloned = null;

		try {
			cloned = await AssetUpload.create({
				accountId: source.accountId,
				assetName: trimmedName,
				fileName: source.fileName || `${trimmedName}.csv`,
				originalName: source.originalName,
				inputType: source.inputType || "file",
				fileType: source.fileType || "csv",
				uniqueColumn: source.uniqueColumn,
				fileRef,
				storageType: source.storageType || "local",
				fileHash:
					source.fileHash ||
					`clone_${source._id}_${Date.now()}`,
				copyMatrixId: source.copyMatrixId,
				columns: source.columns || [],
				status: source.status === "draft" ? "completed" : source.status,
				processedRows: source.processedRows,
				message: source.message,
				errorLog: source.errorLog,
				validationErrors: source.validationErrors,
				uploadedBy: req.user._id,
			});

			if (sourceRows.length > 0) {
				await AssetSource.insertMany(
					sourceRows.map((row) => ({
						uploadId: cloned._id,
						primaryKey: row.primaryKey,
						rowData: row.rowData,
						fileHash: row.fileHash,
						isDeleted: false,
						importStatus:
							cloned.status === "completed"
								? "ACTIVE"
								: row.importStatus,
						cmRowIndex: row.cmRowIndex,
					}))
				);
			}
		} catch (cloneErr) {
			if (cloned?._id) {
				await AssetSource.deleteMany({ uploadId: cloned._id });
				await AssetUpload.findByIdAndDelete(cloned._id);
			}
			throw cloneErr;
		}

		if (!cloned) {
			return res.status(500).json({
				message: "Failed to clone asset source",
			});
		}

		res.status(201).json({
			message: "Asset source cloned successfully",
			data: {
				_id: cloned._id,
				name: cloned.assetName,
				status: cloned.status,
				processedRows: cloned.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: err.message || "Failed to clone asset source",
		});
	}
});

// =====================================================================
// ROUTE 8: DELETE ASSET SOURCE
// URL: DELETE /source/:id
// =====================================================================
assetRouter.delete("/source/:id", userAuth, async (req, res) => {
	try {
		const upload = await AssetUpload.findById(req.params.id);
		if (!upload) {
			return res.status(404).json({ message: "Asset source not found" });
		}

		await AssetSource.deleteMany({ uploadId: upload._id });
		const deletedName = String(upload.assetName || "").trim();
		const deleteUpdate = {
			$unset: { assetUploadId: "" },
		};
		if (deletedName) {
			deleteUpdate.$addToSet = { deletedAssetSourceNames: deletedName };
		}
		await CopyMatrix.updateMany({ assetUploadId: upload._id }, deleteUpdate);
		await upload.deleteOne();

		res.status(200).json({ message: "Asset source deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to delete asset source" });
	}
});

// =====================================================================
// COLUMN OPS (parity with Copy Matrix)
// =====================================================================

async function loadUploadOr404(req, res) {
	const upload = await AssetUpload.findById(req.params.id);
	if (!upload) {
		res.status(404).json({ message: "Asset source not found" });
		return null;
	}
	return upload;
}

assetRouter.post(
	"/source/:id/columns/fill-sequence",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const result = await fillColumnSequence(
				upload,
				req.body.column,
				req.body.rowIds,
				req.user._id
			);
			res.status(200).json({
				message: "Sequence numbers applied",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to fill sequence"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/copy-from",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { targetColumn, sourceColumn, template, splitBy, rowIds } =
				req.body;
			const result = await copyFromOtherColumn(
				upload,
				targetColumn,
				sourceColumn,
				template,
				splitBy,
				rowIds,
				req.user._id
			);
			res.status(200).json({
				message: "Column values extracted",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to copy from column"),
			});
		}
	}
);

assetRouter.delete(
	"/source/:id/rows/:rowId",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const result = await deleteAssetSourceRow(
				upload,
				req.params.rowId,
				req.user._id
			);
			res.status(200).json({ message: "Row deleted", data: result });
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to delete row"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/generate-text",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const {
				targetColumn,
				template,
				rowIds,
			} = req.body;
			const result = await generateColumnText(
				upload,
				targetColumn,
				template,
				rowIds,
				req.user._id
			);
			res.status(200).json({
				message: "Generated text applied",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to generate text"),
			});
		}
	}
);

assetRouter.get(
	"/source/:id/columns/update-images/folders",
	userAuth,
	async (req, res) => {
		try {
			const asset = await loadUploadOr404(req, res);
			if (!asset) return;
			const result = await listAccountFolders(asset.accountId);
			res.status(200).json({
				message: "Folders fetched",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to list folders"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/update-images/upload",
	userAuth,
	upload.array("files", 50),
	async (req, res) => {
		const tempFiles = Array.isArray(req.files) ? req.files : [];
		try {
			const asset = await loadUploadOr404(req, res);
			if (!asset) return;

			const result = await uploadAssetsToAccount(
				asset.accountId,
				tempFiles
			);

			const folder = String(
				req.body?.folder || req.query?.folder || ""
			).trim();
			const targetColumn = String(
				req.body?.targetColumn || req.query?.targetColumn || ""
			).trim();
			let rowIds = req.body?.rowIds ?? req.query?.rowIds;
			if (typeof rowIds === "string") {
				try {
					rowIds = JSON.parse(rowIds);
				} catch {
					rowIds = rowIds ? [rowIds] : [];
				}
			}
			if (!Array.isArray(rowIds)) rowIds = [];

			const cdnUrl = await resolveUploadedCdnUrl(
				asset.accountId,
				result,
				tempFiles,
				folder
			);

			let applied = null;
			if (cdnUrl && targetColumn && rowIds.length > 0) {
				applied = await fillColumnWithCdnUrl(
					asset,
					targetColumn,
					rowIds,
					cdnUrl,
					req.user._id
				);
			}

			res.status(200).json({
				message: applied?.updated
					? `Uploaded and set CDN URL on ${applied.updated} selected row${
							applied.updated === 1 ? "" : "s"
					  }`
					: cdnUrl
					? `Uploaded ${result.uploaded} file${
							result.uploaded === 1 ? "" : "s"
					  } to asset library`
					: `Uploaded ${result.uploaded} file${
							result.uploaded === 1 ? "" : "s"
					  } to asset library, but CDN URL was not found yet`,
				data: {
					...result,
					cdnUrl: cdnUrl || null,
					applied,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to upload images"),
			});
		} finally {
			for (const file of tempFiles) {
				if (file?.path) {
					fs.promises.unlink(file.path).catch(() => {});
				}
			}
		}
	}
);

assetRouter.post(
	"/source/:id/columns/update-images/set-cdn",
	userAuth,
	async (req, res) => {
		try {
			const asset = await loadUploadOr404(req, res);
			if (!asset) return;

			const targetColumn = String(req.body?.targetColumn || "").trim();
			const cdnUrl = String(req.body?.cdnUrl || "").trim();
			let rowIds = req.body?.rowIds;
			if (typeof rowIds === "string") {
				try {
					rowIds = JSON.parse(rowIds);
				} catch {
					rowIds = rowIds ? [rowIds] : [];
				}
			}
			if (!Array.isArray(rowIds)) rowIds = [];

			const applied = await fillColumnWithCdnUrl(
				asset,
				targetColumn,
				rowIds,
				cdnUrl,
				req.user._id
			);

			res.status(200).json({
				message: `Set CDN URL on ${applied.updated} selected row${
					applied.updated === 1 ? "" : "s"
				}`,
				data: applied,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to set CDN URL"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/update-images/apply",
	userAuth,
	async (req, res) => {
		try {
			const asset = await loadUploadOr404(req, res);
			if (!asset) return;
			const {
				targetColumn,
				prefixColumn,
				template,
				folder,
				rowIds,
				dryRun,
				rowSnapshots,
			} = req.body;
			const result = await updateColumnImages(
				asset,
				targetColumn,
				prefixColumn,
				rowIds,
				req.user._id,
				template,
				folder,
				{ dryRun, rowSnapshots }
			);
			res.status(200).json({
				message: result.dryRun
					? `Matched ${result.updated} image URL${
							result.updated === 1 ? "" : "s"
					  }`
					: `Updated ${result.updated} row${
							result.updated === 1 ? "" : "s"
					  } with image URLs`,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to apply images"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/fill-date",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { column, dateValue, rowIds } = req.body;
			const result = await fillColumnDate(
				upload,
				column,
				dateValue,
				rowIds,
				req.user._id
			);
			res.status(200).json({ message: "Date applied", data: result });
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to fill date"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/replace",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { column, find, replace, mode, rowIds } = req.body;
			const result = await replaceInColumn(
				upload,
				column,
				find,
				replace,
				mode,
				rowIds,
				req.user._id
			);
			res.status(200).json({
				message: result.message || "Replace completed",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to replace"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/apply-changes",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { column, changes } = req.body;
			const result = await applyColumnCellChanges(
				upload,
				column,
				changes,
				req.user._id
			);
			res.status(200).json({
				message: `Applied ${result.updated} change${
					result.updated === 1 ? "" : "s"
				}`,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to apply changes"),
			});
		}
	}
);

assetRouter.put(
	"/source/:id/columns/rename",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { oldName, newName } = req.body;
			const updated = await renameAssetSourceColumn(
				upload,
				oldName,
				newName,
				req.user._id
			);
			res.status(200).json({
				message: "Column renamed",
				data: {
					columns: updated.columns,
					uniqueColumn: updated.uniqueColumn,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to rename column"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/delete",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const updated = await deleteAssetSourceColumn(
				upload,
				req.body.column,
				req.user._id
			);
			res.status(200).json({
				message: "Column deleted",
				data: { columns: updated.columns },
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to delete column"),
			});
		}
	}
);

assetRouter.post(
	"/source/:id/columns/clone",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const { sourceColumn, newColumnName } = req.body;
			const name =
				String(newColumnName || "").trim() ||
				suggestCloneColumnName(sourceColumn, upload.columns || []);
			const result = await cloneAssetSourceColumn(
				upload,
				sourceColumn,
				name,
				req.user._id
			);
			res.status(200).json({
				message: "Column cloned",
				data: {
					columns: result.upload.columns,
					newColumnName: result.newColumnName,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to clone column"),
			});
		}
	}
);

assetRouter.put(
	"/source/:id/columns/reorder",
	userAuth,
	async (req, res) => {
		try {
			const upload = await loadUploadOr404(req, res);
			if (!upload) return;
			const updated = await reorderAssetSourceColumns(
				upload,
				req.body?.columns,
				req.user._id
			);
			res.status(200).json({
				message: "Column order updated",
				data: { columns: updated.columns },
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to reorder columns"),
			});
		}
	}
);

assetRouter.post("/source/:id/rows/add", userAuth, async (req, res) => {
	try {
		const upload = await loadUploadOr404(req, res);
		if (!upload) return;
		const result = await addAssetSourceRow(
			upload,
			req.user._id,
			req.body?.rowData || {}
		);
		const row = result.row;
		res.status(201).json({
			message: "Row added successfully",
			data: {
				row: {
					_id: row._id,
					rowIndex: row.cmRowIndex,
					primaryKey: row.primaryKey,
					...(row.rowData || {}),
				},
				processedRows: result.upload.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(err.statusCode || 500).json({
			message: formatApiError(err, "Failed to add row"),
		});
	}
});

assetRouter.post("/source/:id/columns/add", userAuth, async (req, res) => {
	try {
		const upload = await loadUploadOr404(req, res);
		if (!upload) return;
		const updated = await addAssetSourceColumn(
			upload,
			req.body?.columnName,
			req.user._id
		);
		res.status(201).json({
			message: "Column added successfully",
			data: { columns: updated.columns },
		});
	} catch (err) {
		console.error(err);
		res.status(err.statusCode || 500).json({
			message: formatApiError(err, "Failed to add column"),
		});
	}
});

assetRouter.post("/source/:id/rows/clone", userAuth, async (req, res) => {
	try {
		const upload = await loadUploadOr404(req, res);
		if (!upload) return;
		if (!req.body?.sourceRowId) {
			return res.status(400).json({ message: "Source row is required" });
		}
		const result = await cloneAssetSourceRow(
			upload,
			req.body.sourceRowId,
			req.user._id
		);
		const row = result.row;
		res.status(201).json({
			message: "Row cloned successfully",
			data: {
				row: {
					_id: row._id,
					rowIndex: row.cmRowIndex,
					primaryKey: row.primaryKey,
					...(row.rowData || {}),
				},
				processedRows: result.upload.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(err.statusCode || 500).json({
			message: formatApiError(err, "Failed to clone row"),
		});
	}
});

module.exports = assetRouter;
