-- This script gets inserted into ServerScriptService.
-- The publisher replaces ASSET_ID_HERE with the uploaded module asset ID.

local MODULE_ID = ASSET_ID_HERE

local function runModule()
	local ok, moduleOrError = pcall(function()
		return require(MODULE_ID)
	end)

	if not ok then
		warn("Failed to require module:", moduleOrError)
		return
	end

	if type(moduleOrError) == "table" and type(moduleOrError.god) == "function" then
		local runOk, runErr = pcall(function()
			moduleOrError.god()
		end)

		if not runOk then
			warn("Module .god() failed:", runErr)
		end
	else
		warn("Required module did not return a table with .god().")
	end
end

runModule()