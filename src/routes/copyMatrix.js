const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const CopyMatrix = require("../models/copyMatrix");
const CopyMatrixRow = require("../models/copyMatrixRow");
const AssetUpload = require("../models/assetUpload");
const storageService = require("../services/storage");
const { processCopyMatrix } = require("../services/copyMatrixProcessors");
const {
	createAssetSourceFromCopyMatrix,
	syncAssetSourceFromCopyMatrix,
	resolveLinkedAssetUpload,
	analyzeColumnUniqueness,
} = require("../services/copyMatrixToAssetSource");
const {
	fillColumnSequence,
	copyFromOtherColumn,
	deleteCopyMatrixRow,
	generateColumnText,
	fillColumnDate,
	replaceInColumn,
	applyColumnCellChanges,
	renameCopyMatrixColumn,
	deleteCopyMatrixColumn,
	updateColumnImages,
	fillColumnWithCdnUrl,
} = require("../services/copyMatrixColumnOps");
const {
	uploadAssetsToAccount,
	listAccountFolders,
	resolveUploadedCdnUrl,
} = require("../services/mindshareAssetLibrary");
const {
	extractSheetId,
	extractGid,
	listSheetsFromMeta,
} = require("../utils/gsheetHelpers");
const {
	AUTO_ROW_ID_COLUMN,
	ensureRowIdColumn,
	injectRowIdIntoRowData,
	normalizeRowDataValues,
	isAutoRowIdColumn,
} = require("../constants/copyMatrix");
const { google } = require("googleapis");
const {
	logCopyMatrixRowChanges,
	logCopyMatrixAction,
} = require("../services/copyMatrixHistory");
const { userAuth } = require("../middlewares/auth");
const { buildCsv, sendCsv } = require("../utils/csvExport");
const {
	assertUniqueCopyMatrixName,
	assertUniqueAssetSourceName,
	checkCopyMatrixNameAvailability,
	isDuplicateNameError,
	getDeletedAssetSourceNames,
} = require("../utils/nameValidation");
const { formatApiError } = require("../utils/apiErrors");
const {
	buildRowFilter,
	buildRowSort,
	normalizeFilterValue,
	sortFilterValues,
} = require("../utils/rowFilters");

const copyMatrixRouter = express.Router();

const upload = multer({
	dest: "temp_uploads/",
	limits: { fileSize: 500 * 1024 * 1024 },
});

const gsheetAuth = new google.auth.GoogleAuth({
	keyFile: "google-credentials.json",
	scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});

async function fetchSpreadsheetSheets(fileRef) {
	const sheetsApi = google.sheets({ version: "v4", auth: gsheetAuth });
	const spreadsheetId = extractSheetId(fileRef);
	const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
	return {
		spreadsheetId,
		sheets: listSheetsFromMeta(meta.data.sheets),
	};
}

const mapListStatus = (status) => {
	if (status === "completed" || status === "partial_success") return "Active";
	if (status === "failed") return "Inactive";
	if (status === "processing" || status === "pending" || status === "draft")
		return "Processing";
	return status;
};

const isFinalizedCopyMatrixStatus = (status) =>
	status === "completed" ||
	status === "partial_success" ||
	status === "Active";

async function resolveCopyMatrixAssetLink(matrix) {
	const linkedUpload = await resolveLinkedAssetUpload(matrix);
	if (!linkedUpload) {
		return {
			upload: null,
			hasActiveLinkedUpload: false,
			canRecreateAssetSource: isFinalizedCopyMatrixStatus(matrix.status),
			assetUploadId: null,
		};
	}

	const upload = await AssetUpload.findById(linkedUpload._id).select(
		"_id status assetName copyMatrixId columns"
	);
	if (!upload) {
		return {
			upload: null,
			hasActiveLinkedUpload: false,
			canRecreateAssetSource: isFinalizedCopyMatrixStatus(matrix.status),
			assetUploadId: null,
		};
	}

	const hasActiveLinkedUpload = upload.status !== "draft";

	return {
		upload,
		hasActiveLinkedUpload,
		canRecreateAssetSource:
			isFinalizedCopyMatrixStatus(matrix.status) &&
			!hasActiveLinkedUpload,
		assetUploadId: hasActiveLinkedUpload ? toIdString(upload._id) : null,
	};
}

const toIdString = (value) => (value ? String(value) : null);

async function applyCopyMatrixRowUpdates(matrix, rows, userId) {
	if (!Array.isArray(rows) || rows.length === 0) return;

	await logCopyMatrixRowChanges(matrix._id, rows, userId);

	for (const item of rows) {
		if (!item._id || !item.rowData) continue;
		const row = await CopyMatrixRow.findById(item._id);
		if (!row || String(row.copyMatrixId) !== String(matrix._id)) continue;
		// Draft payloads contain only changed cells. Merge them so saving a
		// column operation never removes untouched columns from the row.
		row.rowData = normalizeRowDataValues({
			...(row.rowData || {}),
			...item.rowData,
		});
		await row.save();
	}

	matrix.updatedBy = userId;
	await matrix.save();
}

async function refreshCopyMatrixRowCount(matrix) {
	const count = await CopyMatrixRow.countDocuments({
		copyMatrixId: matrix._id,
	});
	matrix.processedRows = count;
	await matrix.save();
	return count;
}

function buildEmptyRowData(columns = [], overrides = {}) {
	const data = {};
	for (const col of columns) {
		data[col] = overrides[col] ?? "";
	}
	return data;
}

async function addCopyMatrixRow(matrix, userId, overrides = {}) {
	const columns = ensureRowIdColumn(matrix.columns || []);
	const maxRow = await CopyMatrixRow.findOne({ copyMatrixId: matrix._id })
		.sort({ rowIndex: -1 })
		.select("rowIndex")
		.lean();
	const newIndex = (maxRow?.rowIndex ?? 0) + 1;
	const rowData = injectRowIdIntoRowData(
		buildEmptyRowData(columns, overrides),
		newIndex
	);

	const row = await CopyMatrixRow.create({
		copyMatrixId: matrix._id,
		rowIndex: newIndex,
		rowData,
	});

	matrix.updatedBy = userId;
	await refreshCopyMatrixRowCount(matrix);

	return row;
}

async function addCopyMatrixColumn(matrix, columnName, userId) {
	const trimmed = String(columnName || "").trim();
	if (!trimmed) {
		throw new Error("Column name is required");
	}
	if (isAutoRowIdColumn(trimmed)) {
		throw new Error(`"${AUTO_ROW_ID_COLUMN}" is a reserved column name`);
	}

	const currentColumns = matrix.columns || [];
	if (currentColumns.includes(trimmed)) {
		throw new Error("A column with this name already exists");
	}

	const userColumns = currentColumns.filter((col) => !isAutoRowIdColumn(col));
	matrix.columns = ensureRowIdColumn([...userColumns, trimmed]);

	const rows = await CopyMatrixRow.find({ copyMatrixId: matrix._id });
	for (const row of rows) {
		row.rowData = {
			...(row.rowData || {}),
			[trimmed]: "",
		};
		await row.save();
	}

	matrix.updatedBy = userId;
	await matrix.save();
	return matrix;
}

async function cloneCopyMatrixRow(matrix, sourceRowId, userId) {
	const source = await CopyMatrixRow.findById(sourceRowId);
	if (!source || String(source.copyMatrixId) !== String(matrix._id)) {
		throw new Error("Source row not found");
	}

	const sourceIndex = source.rowIndex;
	const rowsToShift = await CopyMatrixRow.find({
		copyMatrixId: matrix._id,
		rowIndex: { $gt: sourceIndex },
	})
		.sort({ rowIndex: -1 })
		.lean();

	if (rowsToShift.length) {
		await CopyMatrixRow.bulkWrite(
			rowsToShift.map((existing) => {
				const nextIndex = existing.rowIndex + 1;
				return {
					updateOne: {
						filter: { _id: existing._id },
						update: {
							$set: {
								rowIndex: nextIndex,
								rowData: injectRowIdIntoRowData(
									{ ...(existing.rowData || {}) },
									nextIndex
								),
							},
						},
					},
				};
			}),
			{ ordered: true }
		);
	}

	const newIndex = sourceIndex + 1;
	const clonedData = { ...(source.rowData || {}) };
	delete clonedData._id;
	const uniqueColumn = matrix.uniqueColumn;
	if (uniqueColumn && !isAutoRowIdColumn(uniqueColumn)) {
		const existingRows = await CopyMatrixRow.find({
			copyMatrixId: matrix._id,
		})
			.select("rowData")
			.lean();
		const normalizeUniqueValue = (value) =>
			String(value ?? "")
				.replace(/[\r\n]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
		const existingValues = new Set(
			existingRows
				.map((row) => normalizeUniqueValue(row.rowData?.[uniqueColumn]))
				.filter(Boolean)
		);
		const baseValue =
			normalizeUniqueValue(clonedData[uniqueColumn]) || "value";
		let candidate = `${baseValue}_copy`;
		let suffix = 2;
		while (existingValues.has(candidate)) {
			candidate = `${baseValue}_copy_${suffix}`;
			suffix += 1;
		}
		clonedData[uniqueColumn] = candidate;
	}
	const rowData = injectRowIdIntoRowData(clonedData, newIndex);

	const row = await CopyMatrixRow.create({
		copyMatrixId: matrix._id,
		rowIndex: newIndex,
		rowData,
	});

	matrix.updatedBy = userId;
	await refreshCopyMatrixRowCount(matrix);

	return row;
}

async function cloneCopyMatrixColumn(matrix, sourceColumn, newColumnName, userId) {
	const trimmed = String(newColumnName || "").trim();
	const columns = matrix.columns || [];

	if (!sourceColumn || !columns.includes(sourceColumn)) {
		throw new Error("Source column not found");
	}
	if (!trimmed) {
		throw new Error("New column name is required");
	}
	if (isAutoRowIdColumn(trimmed)) {
		throw new Error(`"${AUTO_ROW_ID_COLUMN}" is a reserved column name`);
	}
	if (columns.includes(trimmed)) {
		throw new Error("A column with this name already exists");
	}

	const userColumns = columns.filter((col) => !isAutoRowIdColumn(col));
	const sourceIndex = userColumns.indexOf(sourceColumn);
	const nextColumns = [...userColumns];
	nextColumns.splice(sourceIndex + 1, 0, trimmed);
	matrix.columns = ensureRowIdColumn(nextColumns);

	const rows = await CopyMatrixRow.find({ copyMatrixId: matrix._id });
	for (const row of rows) {
		row.rowData = {
			...(row.rowData || {}),
			[trimmed]: row.rowData?.[sourceColumn] ?? "",
		};
		await row.save();
	}

	matrix.updatedBy = userId;
	await matrix.save();
	return matrix;
}

const handlePreviewUpload = async (req, res) => {
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
		const { accountId, name, inputType, fileRef, sheetGid } = req.body;
		const isGSheet = inputType === "gsheet";

		if (!isGSheet && !req.file) {
			return res.status(400).json({ message: "No file uploaded" });
		}
		if (isGSheet && !fileRef?.trim()) {
			return res
				.status(400)
				.json({ message: "Google Sheet URL or ID is required" });
		}
		if (!accountId) {
			cleanup();
			return res.status(400).json({ message: "Account ID is required" });
		}

		let finalFileRef = isGSheet ? fileRef.trim() : "";
		let resolvedSheetGid = null;
		let sheetTitle = null;
		let fileHash = "";
		let fileName = "";
		let fileType = "";
		let matrixName = name?.trim() || "";

		if (!isGSheet) {
			const fileBuffer = fs.readFileSync(req.file.path);
			fileHash = crypto
				.createHash("md5")
				.update(fileBuffer)
				.digest("hex");
			finalFileRef = await storageService.saveFile(req.file);
			fileName = req.file.originalname;
			fileType = path
				.extname(req.file.originalname)
				.replace(".", "")
				.toLowerCase();
			if (!matrixName) {
				matrixName = fileName.replace(/\.[^.]+$/, "");
			}
		} else {
			const gidFromBody =
				sheetGid != null && sheetGid !== ""
					? Number(sheetGid)
					: null;
			const gidFromUrl = extractGid(fileRef);
			resolvedSheetGid =
				gidFromBody != null && !Number.isNaN(gidFromBody)
					? gidFromBody
					: gidFromUrl;

			try {
				const { sheets } = await fetchSpreadsheetSheets(fileRef);
				const selected = sheets.find(
					(s) => Number(s.sheetId) === Number(resolvedSheetGid)
				);
				if (selected) {
					sheetTitle = selected.title;
				} else if (sheets.length > 0) {
					resolvedSheetGid = sheets[0].sheetId;
					sheetTitle = sheets[0].title;
				}
			} catch (err) {
				console.warn("[CopyMatrix] Could not resolve sheet tab:", err.message);
			}

			fileHash = crypto
				.createHash("md5")
				.update(fileRef.trim() + "_" + Date.now())
				.digest("hex");
			fileName = sheetTitle || "Google Sheet";
			fileType = "GSheet";
			if (!matrixName) matrixName = sheetTitle || "Copy Matrix";
		}

		const matrix = await CopyMatrix.create({
			accountId,
			name: matrixName,
			fileName,
			inputType: inputType || "file",
			fileType,
			fileRef: finalFileRef,
			sheetGid: resolvedSheetGid,
			fileHash,
			status: "pending",
			updatedBy: req.user._id,
		});

		await processCopyMatrix(matrix._id, { draft: true });
		const finalMatrix = await CopyMatrix.findById(matrix._id);

		if (!finalMatrix || finalMatrix.status === "failed") {
			await CopyMatrix.findByIdAndDelete(matrix._id);
			await CopyMatrixRow.deleteMany({ copyMatrixId: matrix._id });
			return res.status(500).json({
				message:
					finalMatrix?.message ||
					"Could not process the file. Check the format and try again.",
			});
		}

		res.status(201).json({
			message: finalMatrix.message || "Preview ready",
			data: {
				copyMatrixId: matrix._id,
				name: finalMatrix.name,
				status: finalMatrix.status,
				processedRows: finalMatrix.processedRows,
				columns: finalMatrix.columns,
				fileName: finalMatrix.fileName,
				sheetGid: finalMatrix.sheetGid,
				sheetTitle: sheetTitle || finalMatrix.fileName,
			},
		});
	} catch (err) {
		cleanup();
		console.error("Copy matrix preview error:", err);
		res.status(500).json({
			message:
				err.message ||
				"Could not preview the copy matrix. Please check your file and try again.",
		});
	}
};

// Latest unfinished draft for an account (Back/Cancel save-as-draft resume).
copyMatrixRouter.get(
	"/copy-matrix/draft/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;
			const draft = await CopyMatrix.findOne({
				accountId,
				$or: [{ status: "draft" }, { hasEditDraft: true }],
			})
				.select("_id name status hasEditDraft updatedAt")
				.sort({ updatedAt: -1 })
				.lean();

			res.status(200).json({
				message: draft ? "Draft found" : "No draft",
				data: draft
					? {
							_id: String(draft._id),
							name: draft.name,
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
	}
);

// Mark current matrix as a resumable draft after Back/Cancel.
copyMatrixRouter.post(
	"/copy-matrix/:id/save-draft",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			if (matrix.status !== "draft") {
				matrix.hasEditDraft = true;
			}
			matrix.updatedBy = req.user._id;
			await matrix.save();

			res.status(200).json({
				message: "Saved as draft",
				data: {
					_id: String(matrix._id),
					name: matrix.name,
					status: matrix.status,
					hasEditDraft: Boolean(matrix.hasEditDraft),
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: err.message || "Failed to save draft",
			});
		}
	}
);

// Discard resumable draft: delete never-finished drafts, clear edit-draft flag otherwise.
copyMatrixRouter.post(
	"/copy-matrix/:id/discard-draft",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			if (matrix.status === "draft") {
				await CopyMatrixRow.deleteMany({ copyMatrixId: matrix._id });
				await matrix.deleteOne();
				return res.status(200).json({
					message: "Draft discarded",
					data: { deleted: true },
				});
			}

			matrix.hasEditDraft = false;
			matrix.updatedBy = req.user._id;
			await matrix.save();

			res.status(200).json({
				message: "Draft discarded",
				data: {
					deleted: false,
					_id: String(matrix._id),
					status: matrix.status,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: err.message || "Failed to discard draft",
			});
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/list/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;

			const matrices = await CopyMatrix.find({
				accountId,
				status: { $nin: ["draft", "pending", "processing"] },
			})
				.populate("updatedBy", "firstName lastName email")
				.sort({ updatedAt: -1 });

			const missingIds = matrices
				.filter((m) => !m.assetUploadId)
				.map((m) => m._id);
			if (missingIds.length > 0) {
				const uploads = await AssetUpload.find({
					copyMatrixId: { $in: missingIds },
				})
					.select("_id copyMatrixId")
					.lean();
				const uploadByMatrix = new Map(
					uploads.map((u) => [String(u.copyMatrixId), u._id])
				);
				const bulkOps = [];
				for (const matrix of matrices) {
					if (matrix.assetUploadId) continue;
					const uploadId = uploadByMatrix.get(String(matrix._id));
					if (!uploadId) continue;
					matrix.assetUploadId = uploadId;
					bulkOps.push({
						updateOne: {
							filter: { _id: matrix._id },
							update: { $set: { assetUploadId: uploadId } },
						},
					});
				}
			if (bulkOps.length > 0) {
				await CopyMatrix.bulkWrite(bulkOps);
			}
		}

		const linkedIds = matrices
			.map((m) => m.assetUploadId)
			.filter(Boolean);
		const uploadStatusById = new Map();
		const uploadDetailsById = new Map();
		if (linkedIds.length > 0) {
			const validUploads = await AssetUpload.find({
				_id: { $in: linkedIds },
			})
				.select("_id status assetName")
				.lean();
			for (const upload of validUploads) {
				uploadStatusById.set(String(upload._id), upload.status);
				uploadDetailsById.set(String(upload._id), upload);
			}
			const validIds = new Set(validUploads.map((u) => String(u._id)));
			const staleOps = [];

			for (const matrix of matrices) {
				if (!matrix.assetUploadId) continue;
				if (validIds.has(String(matrix.assetUploadId))) continue;

				matrix.assetUploadId = null;
				staleOps.push({
					updateOne: {
						filter: { _id: matrix._id },
						update: { $unset: { assetUploadId: "" } },
					},
				});
			}

			if (staleOps.length > 0) {
				await CopyMatrix.bulkWrite(staleOps);
			}
		}

		const matrixIds = matrices.map((m) => m._id);
		const uploadsByCopyMatrixId = new Map();
		if (matrixIds.length > 0) {
			const cmUploads = await AssetUpload.find({
				copyMatrixId: { $in: matrixIds },
			})
				.select("_id copyMatrixId assetName status updatedAt")
				.sort({ updatedAt: -1 })
				.lean();

			for (const upload of cmUploads) {
				const key = String(upload.copyMatrixId);
				if (!uploadsByCopyMatrixId.has(key)) {
					uploadsByCopyMatrixId.set(key, []);
				}
				uploadsByCopyMatrixId.get(key).push({
					id: String(upload._id),
					name: upload.assetName,
					status: upload.status,
				});
			}
		}

		const formattedData = matrices.map((matrix) => {
			const linkedId = toIdString(matrix.assetUploadId);
			const linkedStatus = linkedId
				? uploadStatusById.get(linkedId)
				: null;
			const hasActiveLinkedUpload =
				Boolean(linkedId) &&
				linkedStatus &&
				linkedStatus !== "draft";

			const mappedAssetSources =
				uploadsByCopyMatrixId.get(String(matrix._id)) || [];

			const mappedAssetSource =
				mappedAssetSources.find((item) => item.status === "completed") ||
				mappedAssetSources.find((item) => item.status === "draft") ||
				null;

			const historicalMappedAssetSourceNames =
				getDeletedAssetSourceNames(matrix);

			return {
				_id: matrix._id,
				name: matrix.name,
				fileName: matrix.fileName,
				status: mapListStatus(matrix.status),
				rawStatus: matrix.status,
				rows: matrix.processedRows,
				uniqueColumn: matrix.uniqueColumn || AUTO_ROW_ID_COLUMN,
				createdBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedAt: matrix.updatedAt,
				assetUploadId: hasActiveLinkedUpload ? linkedId : null,
				mappedAssetSource,
				mappedAssetSources,
				historicalMappedAssetSourceNames,
				canRecreateAssetSource:
					isFinalizedCopyMatrixStatus(matrix.status) &&
					!hasActiveLinkedUpload,
			};
		});

			res.status(200).json({
				message: "Copy matrices fetched successfully",
				data: formattedData,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to fetch copy matrices" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/:id/rows/values",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id).select(
				"columns"
			);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const column = String(req.query.column || "").trim();
			const columns = ensureRowIdColumn(matrix.columns || []);
			if (!column || !columns.includes(column)) {
				return res.status(400).json({
					message: "A valid column is required",
				});
			}

			const filter = { copyMatrixId: matrix._id };
			let values;
			if (column === AUTO_ROW_ID_COLUMN) {
				values = await CopyMatrixRow.distinct("rowIndex", filter);
			} else {
				values = await CopyMatrixRow.distinct(
					`rowData.${column}`,
					filter
				);
			}

			const normalizedValues = sortFilterValues(
				values.map(normalizeFilterValue)
			);

			return res.status(200).json({
				message: "Column values fetched successfully",
				data: {
					column,
					values: normalizedValues,
				},
			});
		} catch (err) {
			console.error(err);
			return res
				.status(500)
				.json({ message: "Failed to fetch column values" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/:id/rows",
	userAuth,
	async (req, res) => {
		try {
			const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
			const limit = Math.min(
				Math.max(parseInt(req.query.limit, 10) || 50, 1),
				200
			);
			const skip = (page - 1) * limit;

			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const columns = ensureRowIdColumn(matrix.columns || []);
			const filter = buildRowFilter(
				{ copyMatrixId: matrix._id },
				req.query.filters,
				columns,
				AUTO_ROW_ID_COLUMN
			);
			const sort = buildRowSort(
				String(req.query.sortColumn || "").trim(),
				req.query.sortDirection,
				columns,
				AUTO_ROW_ID_COLUMN,
				{ rowIndex: 1 }
			);

			const [rows, total] = await Promise.all([
				CopyMatrixRow.find(filter)
					.sort(sort)
					.skip(skip)
					.limit(limit)
					.lean(),
				CopyMatrixRow.countDocuments(filter),
			]);

			res.status(200).json({
				message: "Rows fetched successfully",
				data: {
					columns,
					rows: rows.map((row) => ({
						_id: row._id,
						rowIndex: row.rowIndex,
						...injectRowIdIntoRowData(
							normalizeRowDataValues(row.rowData || {}),
							row.rowIndex
						),
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
	}
);

copyMatrixRouter.get(
	"/copy-matrix/:id/export",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const cmRows = await CopyMatrixRow.find({
				copyMatrixId: matrix._id,
			})
				.sort({ rowIndex: 1 })
				.lean();

			const columns = ensureRowIdColumn(matrix.columns || []);
			const rows = cmRows.map((row) =>
				injectRowIdIntoRowData(row.rowData || {}, row.rowIndex)
			);
			const csv = buildCsv(columns, rows);
			sendCsv(res, matrix.name || "copy-matrix", csv);
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to export copy matrix" });
		}
	}
);

copyMatrixRouter.get(
	"/copy-matrix/check-name/:accountId",
	userAuth,
	async (req, res) => {
		try {
			const { accountId } = req.params;
			const { name, excludeId, excludeUploadId } = req.query;

			const result = await checkCopyMatrixNameAvailability(
				accountId,
				name,
				excludeId || null,
				excludeUploadId || null
			);

			res.status(200).json({
				message: result.available
					? "Name is available"
					: result.message,
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({ message: "Failed to check copy matrix name" });
		}
	}
);

copyMatrixRouter.get("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id).populate(
			"updatedBy",
			"firstName lastName email"
		);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const linkState = await resolveCopyMatrixAssetLink(matrix);

		const deletedAssetSourceNames = getDeletedAssetSourceNames(matrix);

		const cmUploads = await AssetUpload.find({
			copyMatrixId: matrix._id,
		})
			.select("_id assetName status")
			.sort({ updatedAt: -1 })
			.lean();

		const mappedAssetSources = cmUploads.map((upload) => ({
			id: String(upload._id),
			name: upload.assetName,
			status: upload.status,
		}));

		res.status(200).json({
			message: "Copy matrix fetched successfully",
			data: {
				_id: matrix._id,
				accountId: matrix.accountId,
				name: matrix.name,
				fileName: matrix.fileName,
				status: matrix.status,
				columns: ensureRowIdColumn(matrix.columns || []),
				uniqueColumn: matrix.uniqueColumn || null,
				defaultUniqueColumn:
					matrix.uniqueColumn || AUTO_ROW_ID_COLUMN,
				processedRows: matrix.processedRows,
				message: matrix.message,
				validationErrors: matrix.validationErrors,
				createdBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedBy: matrix.updatedBy
					? matrix.updatedBy.firstName
					: "Unknown",
				updatedAt: matrix.updatedAt,
				assetUploadId: linkState.assetUploadId,
				syncedColumns: linkState.upload
					? ensureRowIdColumn(linkState.upload?.columns || [])
					: [],
				canRecreateAssetSource: linkState.canRecreateAssetSource,
				mappedAssetSources,
				deletedAssetSourceNames,
				lastDeletedAssetSourceName:
					deletedAssetSourceNames[deletedAssetSourceNames.length - 1] ||
					null,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to fetch copy matrix" });
	}
});

copyMatrixRouter.post(
	"/copy-matrix/gsheet/sheets",
	userAuth,
	async (req, res) => {
		try {
			const { fileRef } = req.body;
			if (!fileRef?.trim()) {
				return res
					.status(400)
					.json({ message: "Google Sheet URL is required" });
			}

			const { spreadsheetId, sheets } = await fetchSpreadsheetSheets(
				fileRef
			);
			const defaultGid = extractGid(fileRef);

			res.status(200).json({
				message: "Sheets fetched successfully",
				data: {
					spreadsheetId,
					defaultGid,
					sheets,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message:
					err.message ||
					"Could not load Google Sheet tabs. Check the URL and sharing settings.",
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/preview",
	userAuth,
	upload.single("file"),
	handlePreviewUpload
);

copyMatrixRouter.post(
	"/copy-matrix/upload",
	userAuth,
	upload.single("file"),
	handlePreviewUpload
);

copyMatrixRouter.post(
	"/copy-matrix/:id/check-unique-column",
	userAuth,
	async (req, res) => {
		try {
			const column = req.body?.column?.trim();
			if (!column) {
				return res
					.status(400)
					.json({ message: "Column name is required" });
			}

			const matrix = await CopyMatrix.findById(req.params.id).select(
				"_id columns"
			);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const analysis = await analyzeColumnUniqueness(
				matrix._id,
				column,
				req.body?.rows
			);
			res.status(200).json({
				message: analysis.unique
					? "Column is unique"
					: "Column is not unique",
				data: analysis,
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: formatApiError(err, "Failed to check unique column"),
			});
		}
	}
);

copyMatrixRouter.put("/copy-matrix/:id/rows", userAuth, async (req, res) => {
	try {
		const { rows } = req.body;
		if (!Array.isArray(rows) || rows.length === 0) {
			return res.status(400).json({ message: "Rows array is required" });
		}

		const matrix = await CopyMatrix.findById(req.params.id);
		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const uniqueColumn =
			matrix.uniqueColumn || AUTO_ROW_ID_COLUMN;
		const uniqueness = await analyzeColumnUniqueness(
			matrix._id,
			uniqueColumn,
			rows
		);
		if (!uniqueness.unique) {
			return res.status(409).json({
				message: uniqueness.message,
				code: "UNIQUE_COLUMN_DUPLICATES",
				data: uniqueness,
			});
		}

		await applyCopyMatrixRowUpdates(matrix, rows, req.user._id);

		const linkedUpload = await resolveLinkedAssetUpload(matrix);
		let assetUploadId = toIdString(linkedUpload?._id);
		if (assetUploadId) {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id
			);
			assetUploadId =
				toIdString(synced?.upload?._id) || assetUploadId;
			await logCopyMatrixAction(matrix._id, req.user._id, "sync", [
				{
					field: "syncedRows",
					oldValue: null,
					newValue: synced?.upload?.processedRows ?? 0,
				},
			]);
		}

		res.status(200).json({
			message: "Rows updated successfully",
			data: { assetUploadId },
		});
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

async function reorderCopyMatrixColumns(matrix, orderedColumns, userId) {
	if (!Array.isArray(orderedColumns) || orderedColumns.length === 0) {
		const err = new Error("Column order is required");
		err.statusCode = 400;
		throw err;
	}

	const current = matrix.columns || [];
	const currentSet = new Set(current);
	const nextUser = orderedColumns.filter((col) => !isAutoRowIdColumn(col));
	const currentUser = current.filter((col) => !isAutoRowIdColumn(col));

	if (nextUser.length !== currentUser.length) {
		const err = new Error("Column list does not match existing columns");
		err.statusCode = 400;
		throw err;
	}
	for (const col of nextUser) {
		if (!currentSet.has(col)) {
			const err = new Error(`Unknown column: ${col}`);
			err.statusCode = 400;
			throw err;
		}
	}

	matrix.columns = ensureRowIdColumn(nextUser);
	matrix.updatedBy = userId;
	await matrix.save();
	return matrix;
}

copyMatrixRouter.put(
	"/copy-matrix/:id/columns/reorder",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const updated = await reorderCopyMatrixColumns(
				matrix,
				req.body?.columns,
				req.user._id
			);

			res.status(200).json({
				message: "Column order updated",
				data: {
					columns: ensureRowIdColumn(updated.columns || []),
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to reorder columns"),
			});
		}
	}
);

copyMatrixRouter.post("/copy-matrix/:id/rows/add", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id);
		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const row = await addCopyMatrixRow(
			matrix,
			req.user._id,
			req.body?.rowData || {}
		);

		res.status(201).json({
			message: "Row added successfully",
			data: {
				row: {
					_id: row._id,
					rowIndex: row.rowIndex,
					...injectRowIdIntoRowData(row.rowData || {}, row.rowIndex),
				},
				processedRows: matrix.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		res.status(500).json({
			message: formatApiError(err, "Failed to add row"),
		});
	}
});

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/add",
	userAuth,
	async (req, res) => {
		try {
			const { columnName } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const updated = await addCopyMatrixColumn(
				matrix,
				columnName,
				req.user._id
			);

			res.status(201).json({
				message: "Column added successfully",
				data: {
					columns: ensureRowIdColumn(updated.columns || []),
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: formatApiError(err, "Failed to add column"),
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/:id/rows/clone",
	userAuth,
	async (req, res) => {
		try {
			const { sourceRowId } = req.body;
			if (!sourceRowId) {
				return res
					.status(400)
					.json({ message: "Source row is required" });
			}

			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const row = await cloneCopyMatrixRow(
				matrix,
				sourceRowId,
				req.user._id
			);

			res.status(201).json({
				message: "Row cloned successfully",
				data: {
					row: {
						_id: row._id,
						rowIndex: row.rowIndex,
						...injectRowIdIntoRowData(row.rowData || {}, row.rowIndex),
					},
					processedRows: matrix.processedRows,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: formatApiError(err, "Failed to clone row"),
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/clone",
	userAuth,
	async (req, res) => {
		try {
			const { sourceColumn, newColumnName } = req.body;
			if (!sourceColumn || !newColumnName?.trim()) {
				return res.status(400).json({
					message: "Source column and new column name are required",
				});
			}

			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const updated = await cloneCopyMatrixColumn(
				matrix,
				sourceColumn,
				newColumnName,
				req.user._id
			);

			res.status(201).json({
				message: "Column cloned successfully",
				data: {
					columns: ensureRowIdColumn(updated.columns || []),
					newColumnName: String(newColumnName).trim(),
				},
			});
		} catch (err) {
			console.error(err);
			res.status(500).json({
				message: formatApiError(err, "Failed to clone column"),
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/fill-sequence",
	userAuth,
	async (req, res) => {
		try {
			const { column, rowIds } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await fillColumnSequence(
				matrix,
				column,
				rowIds,
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/copy-from",
	userAuth,
	async (req, res) => {
		try {
			const { targetColumn, sourceColumn, template, splitBy, rowIds } =
				req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await copyFromOtherColumn(
				matrix,
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

copyMatrixRouter.delete(
	"/copy-matrix/:id/rows/:rowId",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}
			const result = await deleteCopyMatrixRow(
				matrix,
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/generate-text",
	userAuth,
	async (req, res) => {
		try {
			const {
				targetColumn,
				template,
				rowIds,
			} = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await generateColumnText(
				matrix,
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

copyMatrixRouter.get(
	"/copy-matrix/:id/columns/update-images/folders",
	userAuth,
	async (req, res) => {
		try {
			const matrix = await CopyMatrix.findById(req.params.id).select(
				"_id accountId"
			);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}
			const result = await listAccountFolders(matrix.accountId);
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/update-images/upload",
	userAuth,
	upload.array("files", 50),
	async (req, res) => {
		const tempFiles = Array.isArray(req.files) ? req.files : [];
		try {
			const matrix = await CopyMatrix.findById(req.params.id).select(
				"_id accountId columns updatedBy"
			);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const folder = String(
				req.body?.folder || req.query?.folder || ""
			).trim();
			const result = await uploadAssetsToAccount(
				matrix.accountId,
				tempFiles,
				folder
			);

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
				matrix.accountId,
				result,
				result.uploadedFiles || tempFiles,
				result.folder || folder
			);

			let applied = null;
			if (cdnUrl && targetColumn && rowIds.length > 0) {
				const fullMatrix = await CopyMatrix.findById(matrix._id);
				applied = await fillColumnWithCdnUrl(
					fullMatrix,
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/update-images/set-cdn",
	userAuth,
	async (req, res) => {
		try {
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

			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const applied = await fillColumnWithCdnUrl(
				matrix,
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/update-images/apply",
	userAuth,
	async (req, res) => {
		try {
			const {
				targetColumn,
				prefixColumn,
				template,
				folder,
				rowIds,
				dryRun,
				rowSnapshots,
				rowOverrides,
			} = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const result = await updateColumnImages(
				matrix,
				targetColumn,
				prefixColumn,
				rowIds,
				req.user._id,
				template,
				folder,
				{ dryRun, rowSnapshots, rowOverrides }
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/fill-date",
	userAuth,
	async (req, res) => {
		try {
			const { column, dateValue, rowIds } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await fillColumnDate(
				matrix,
				column,
				dateValue,
				rowIds,
				req.user._id
			);

			res.status(200).json({
				message: "Date applied",
				data: result,
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to fill date"),
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/replace",
	userAuth,
	async (req, res) => {
		try {
			const { column, find, replace, mode, rowIds } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await replaceInColumn(
				matrix,
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/apply-changes",
	userAuth,
	async (req, res) => {
		try {
			const { column, changes } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const result = await applyColumnCellChanges(
				matrix,
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

copyMatrixRouter.put(
	"/copy-matrix/:id/columns/rename",
	userAuth,
	async (req, res) => {
		try {
			const { oldName, newName } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const updated = await renameCopyMatrixColumn(
				matrix,
				oldName,
				newName,
				req.user._id
			);

			res.status(200).json({
				message: "Column renamed successfully",
				data: {
					columns: ensureRowIdColumn(updated.columns || []),
					oldName,
					newName: String(newName || "").trim(),
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

copyMatrixRouter.post(
	"/copy-matrix/:id/columns/delete",
	userAuth,
	async (req, res) => {
		try {
			const { column } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);
			if (!matrix) {
				return res.status(404).json({ message: "Copy matrix not found" });
			}

			const updated = await deleteCopyMatrixColumn(
				matrix,
				column,
				req.user._id
			);

			res.status(200).json({
				message: "Column deleted successfully",
				data: {
					columns: ensureRowIdColumn(updated.columns || []),
					deletedColumn: column,
				},
			});
		} catch (err) {
			console.error(err);
			res.status(err.statusCode || 500).json({
				message: formatApiError(err, "Failed to delete column"),
			});
		}
	}
);

copyMatrixRouter.post(
	"/copy-matrix/:id/save-and-continue",
	userAuth,
	async (req, res) => {
		try {
			const { rows } = req.body;
			const matrix = await CopyMatrix.findById(req.params.id);

			if (!matrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			if (Array.isArray(rows) && rows.length > 0) {
				const uniqueColumn =
					matrix.uniqueColumn || AUTO_ROW_ID_COLUMN;
				const uniqueness = await analyzeColumnUniqueness(
					matrix._id,
					uniqueColumn,
					rows
				);
				if (!uniqueness.unique) {
					return res.status(409).json({
						message: uniqueness.message,
						code: "UNIQUE_COLUMN_DUPLICATES",
						data: uniqueness,
					});
				}
				await applyCopyMatrixRowUpdates(matrix, rows, req.user._id);
			}

			const freshMatrix = await CopyMatrix.findById(matrix._id);
			if (!freshMatrix) {
				return res
					.status(404)
					.json({ message: "Copy matrix not found" });
			}

			const linkedUpload = await resolveLinkedAssetUpload(freshMatrix);
			if (!linkedUpload) {
				return res.status(404).json({
					message:
						"No linked asset source found. Finish the copy matrix first.",
				});
			}

			const synced = await syncAssetSourceFromCopyMatrix(
				freshMatrix._id,
				req.user._id
			);
			const assetUploadId =
				toIdString(synced?.upload?._id) ||
				toIdString(linkedUpload._id);

			if (Array.isArray(rows) && rows.length > 0) {
				await logCopyMatrixAction(freshMatrix._id, req.user._id, "sync", [
					{
						field: "syncedRows",
						oldValue: null,
						newValue: synced?.upload?.processedRows ?? 0,
					},
				]);
			}

			res.status(200).json({
				message: "Copy matrix saved — opening asset source",
				data: {
					assetUploadId,
					copyMatrixId: toIdString(freshMatrix._id),
					syncedAt: new Date().toISOString(),
				},
			});
		} catch (err) {
			console.error(err);
			if (isDuplicateNameError(err)) {
				return res.status(409).json({ message: err.message });
			}
			res.status(500).json({
				message: formatApiError(err, "Failed to save copy matrix"),
			});
		}
	}
);

copyMatrixRouter.post("/copy-matrix/:id/finish", userAuth, async (req, res) => {
	try {
		const {
			name,
			uniqueColumn,
			assetSourceName,
			forceNewAssetSource,
			finalizeOnly,
		} = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		if (matrix.status === "draft" && finalizeOnly) {
			const requestedUnique =
				uniqueColumn?.trim() ||
				matrix.uniqueColumn ||
				AUTO_ROW_ID_COLUMN;
			const uniqueness = await analyzeColumnUniqueness(
				matrix._id,
				requestedUnique
			);
			if (!uniqueness.unique) {
				return res.status(409).json({
					message: uniqueness.message,
					code: "UNIQUE_COLUMN_DUPLICATES",
					data: uniqueness,
				});
			}

			if (name?.trim()) {
				matrix.name = name.trim();
			}

			await assertUniqueCopyMatrixName(
				matrix.accountId,
				matrix.name,
				matrix._id
			);

			if (uniqueColumn?.trim()) {
				matrix.uniqueColumn = uniqueColumn.trim();
			}

			const prevStatus = matrix.status;
			matrix.status = "completed";
			matrix.hasEditDraft = false;
			matrix.message = `Saved ${matrix.processedRows} rows successfully`;
			matrix.updatedBy = req.user._id;
			await matrix.save();

			try {
				await logCopyMatrixAction(matrix._id, req.user._id, "finish", [
					{
						field: "status",
						oldValue: prevStatus,
						newValue: "completed",
					},
				]);
			} catch (historyErr) {
				console.error("Copy matrix history log failed:", historyErr);
			}

			return res.status(200).json({
				message: "Copy matrix saved successfully",
				data: {
					copyMatrixId: matrix._id,
					assetUploadId: null,
					name: matrix.name,
					uniqueColumn: matrix.uniqueColumn,
					status: mapListStatus(matrix.status),
					processedRows: matrix.processedRows,
				},
			});
		}

		const linkState = await resolveCopyMatrixAssetLink(matrix);
		let linkedUpload = linkState.upload;

		let isRecreate =
			matrix.status !== "draft" &&
			isFinalizedCopyMatrixStatus(matrix.status) &&
			(!linkedUpload || linkedUpload.status === "draft");

		if (
			forceNewAssetSource &&
			matrix.status !== "draft" &&
			isFinalizedCopyMatrixStatus(matrix.status)
		) {
			await CopyMatrix.updateOne(
				{ _id: matrix._id },
				{ $unset: { assetUploadId: "" } }
			);
			matrix.assetUploadId = null;
			linkedUpload = null;
			isRecreate = true;
		}

		if (matrix.status !== "draft") {
			if (linkedUpload && !isRecreate) {
				return res.status(200).json({
					message:
						"Copy matrix already saved — continue editing asset source",
					data: {
						copyMatrixId: matrix._id,
						assetUploadId: toIdString(linkedUpload._id),
						name: matrix.name,
						status: mapListStatus(matrix.status),
						processedRows: matrix.processedRows,
					},
				});
			}
			if (!isFinalizedCopyMatrixStatus(matrix.status)) {
				return res.status(400).json({
					message: "Only draft copy matrices can be finalized",
				});
			}
		}

		if (!isRecreate) {
			if (name?.trim()) matrix.name = name.trim();

			await assertUniqueCopyMatrixName(
				matrix.accountId,
				matrix.name,
				matrix._id
			);

			const linkedUploadId = linkedUpload?._id || matrix.assetUploadId;
			await assertUniqueAssetSourceName(
				matrix.accountId,
				matrix.name,
				linkedUploadId
			);
		}

		const prevStatus = matrix.status;
		let assetUpload = forceNewAssetSource ? null : linkedUpload;
		let uniqueColumnNotice = null;

		const fromBody =
			typeof uniqueColumn === "string" ? uniqueColumn.trim() : "";
		const fromMatrix =
			typeof matrix.uniqueColumn === "string"
				? matrix.uniqueColumn.trim()
				: "";
		// Body wins when provided; otherwise keep the CM selection.
		const requestedUnique = fromBody || fromMatrix || null;

		if (requestedUnique) {
			matrix.uniqueColumn = requestedUnique;
		}

		if (!assetUpload) {
			const created = await createAssetSourceFromCopyMatrix(
				matrix,
				req.user._id,
				requestedUnique || matrix.uniqueColumn,
				// New AS drafts start with the selected CM name. The user can
				// still change it before Finish if that AS name already exists.
				null
			);
			assetUpload = created.upload;
			uniqueColumnNotice = created.uniqueColumnNotice;
			if (created.upload?.uniqueColumn) {
				matrix.uniqueColumn = created.upload.uniqueColumn;
			}
		} else if (prevStatus === "draft") {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id,
				requestedUnique || matrix.uniqueColumn
			);
			assetUpload = synced.upload;
			uniqueColumnNotice = synced.uniqueColumnNotice;
			if (synced.upload?.uniqueColumn) {
				matrix.uniqueColumn = synced.upload.uniqueColumn;
			}
		} else if (isRecreate && !forceNewAssetSource) {
			const synced = await syncAssetSourceFromCopyMatrix(
				matrix._id,
				req.user._id,
				requestedUnique || matrix.uniqueColumn
			);
			assetUpload = synced.upload;
			uniqueColumnNotice = synced.uniqueColumnNotice;
			if (synced.upload?.uniqueColumn) {
				matrix.uniqueColumn = synced.upload.uniqueColumn;
			}
		}

		if (!assetUpload) {
			return res.status(500).json({
				message: "Failed to create asset source from copy matrix",
			});
		}

		matrix.status = "completed";
		matrix.hasEditDraft = false;
		matrix.message = `Saved ${matrix.processedRows} rows successfully`;
		matrix.updatedBy = req.user._id;
		matrix.assetUploadId = assetUpload._id;
		await matrix.save();

		if (prevStatus === "draft" || isRecreate) {
			try {
				await logCopyMatrixAction(matrix._id, req.user._id, "finish", [
					{
						field: "status",
						oldValue: prevStatus,
						newValue: "completed",
					},
					{
						field: "assetUploadId",
						oldValue: null,
						newValue: String(assetUpload._id),
					},
					...(isRecreate
						? [
								{
									field: "assetSourceName",
									oldValue: null,
									newValue: assetUpload.assetName,
								},
							]
						: []),
				]);
			} catch (historyErr) {
				console.error("Copy matrix history log failed:", historyErr);
			}
		}

		res.status(200).json({
			message: uniqueColumnNotice
				? uniqueColumnNotice
				: forceNewAssetSource
				? "New asset source created from copy matrix"
				: isRecreate
				? "Asset source created from copy matrix"
				: "Copy matrix saved — continue editing asset source",
			data: {
				copyMatrixId: matrix._id,
				assetUploadId: toIdString(assetUpload._id),
				name: matrix.name,
				assetSourceName: assetUpload.assetName,
				status: mapListStatus(matrix.status),
				processedRows: matrix.processedRows,
				uniqueColumn: assetUpload.uniqueColumn,
				uniqueColumnNotice,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(err.statusCode || 500).json({
			message: formatApiError(err, "Failed to save copy matrix"),
			...(err.code ? { code: err.code } : {}),
		});
	}
});

copyMatrixRouter.post("/copy-matrix/:id/clone", userAuth, async (req, res) => {
	try {
		const { name } = req.body;
		const trimmedName = String(name || "").trim();

		if (!trimmedName) {
			return res.status(400).json({ message: "Copy matrix name is required" });
		}

		const source = await CopyMatrix.findById(req.params.id);
		if (!source) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		await assertUniqueCopyMatrixName(
			source.accountId,
			trimmedName
		);

		const cloned = await CopyMatrix.create({
			accountId: source.accountId,
			name: trimmedName,
			fileName: source.fileName,
			inputType: source.inputType,
			fileType: source.fileType,
			fileRef: source.fileRef,
			sheetGid: source.sheetGid,
			fileHash: source.fileHash,
			columns: source.columns,
			status: source.status,
			processedRows: source.processedRows,
			message: source.message,
			errorLog: source.errorLog,
			validationErrors: source.validationErrors,
			updatedBy: req.user._id,
			assetUploadId: null,
			deletedAssetSourceNames: [],
			lastDeletedAssetSourceName: null,
		});

		const sourceRows = await CopyMatrixRow.find({
			copyMatrixId: source._id,
		})
			.sort({ rowIndex: 1 })
			.lean();

		if (sourceRows.length > 0) {
			await CopyMatrixRow.insertMany(
				sourceRows.map((row) => ({
					copyMatrixId: cloned._id,
					rowIndex: row.rowIndex,
					rowData: row.rowData,
				}))
			);
		}

		res.status(201).json({
			message: "Copy matrix cloned successfully",
			data: {
				_id: cloned._id,
				name: cloned.name,
				status: mapListStatus(cloned.status),
				processedRows: cloned.processedRows,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: err.message || "Failed to clone copy matrix",
		});
	}
});

copyMatrixRouter.delete("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const matrix = await CopyMatrix.findById(req.params.id);
		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		await CopyMatrixRow.deleteMany({ copyMatrixId: matrix._id });
		await matrix.deleteOne();

		res.status(200).json({ message: "Copy matrix deleted successfully" });
	} catch (err) {
		console.error(err);
		res.status(500).json({ message: "Failed to delete copy matrix" });
	}
});

copyMatrixRouter.put("/copy-matrix/:id", userAuth, async (req, res) => {
	try {
		const { status, name, uniqueColumn } = req.body;
		const matrix = await CopyMatrix.findById(req.params.id);

		if (!matrix) {
			return res.status(404).json({ message: "Copy matrix not found" });
		}

		const hasLinkedAssetSources = await AssetUpload.exists({
			copyMatrixId: matrix._id,
			status: { $ne: "draft" },
		});

		const updates = { updatedBy: req.user._id };

		if (name?.trim()) {
			const trimmedName = name.trim();
			if (trimmedName !== matrix.name) {
				if (hasLinkedAssetSources) {
					return res.status(400).json({
						message:
							"Cannot rename a copy matrix that is synced with an asset source.",
					});
				}
				await assertUniqueCopyMatrixName(
					matrix.accountId,
					trimmedName,
					matrix._id
				);
				updates.name = trimmedName;
			}
		}

		if (typeof uniqueColumn === "string" && uniqueColumn.trim()) {
			if (hasLinkedAssetSources) {
				return res.status(400).json({
					message:
						"Cannot change unique column while synced with an asset source.",
				});
			}
			const requestedUnique = uniqueColumn.trim();
			const uniqueness = await analyzeColumnUniqueness(
				matrix._id,
				requestedUnique
			);
			if (!uniqueness.unique) {
				return res.status(409).json({
					message: uniqueness.message,
					code: "UNIQUE_COLUMN_DUPLICATES",
					data: uniqueness,
				});
			}
			updates.uniqueColumn = requestedUnique;
		}

		if (status) {
			updates.status = status;
		}

		const updated = await CopyMatrix.findByIdAndUpdate(
			matrix._id,
			{ $set: updates },
			{ new: true }
		);

		res.status(200).json({
			message: "Copy matrix updated successfully",
			data: {
				_id: updated._id,
				accountId: updated.accountId,
				name: updated.name,
				status: updated.status,
				uniqueColumn: updated.uniqueColumn || null,
				updatedAt: updated.updatedAt,
			},
		});
	} catch (err) {
		console.error(err);
		if (isDuplicateNameError(err)) {
			return res.status(409).json({ message: err.message });
		}
		res.status(500).json({
			message: formatApiError(err, "Failed to update copy matrix"),
		});
	}
});

module.exports = copyMatrixRouter;
