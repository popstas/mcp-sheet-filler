---
name: fill-sheet
description: Use the sheet-filler MCP server to safely auto-fill tabular data.
---

## Purpose

The sheet-filler server manages objects (rows) with fields (columns). It prevents overwriting existing values, making it safe for incremental data collection.

## Workflow

### Setup (if needed)

#### Authenticate to Google Sheets

If not authenticated, use the device code flow:

```
# 1. Check status
filler_google_auth({ action: "status" })
→ { status: "Not authenticated. Use start_auth to begin authentication." }

# 2. Start auth
filler_google_auth({ action: "start_auth" })
→ { verification_url: "https://www.google.com/device", user_code: "ABCD-EFGH", device_code: "xyz123", instructions: "Visit ... and enter code: ABCD-EFGH" }

# 3. Tell user to visit URL and enter code, wait for confirmation

# 4. Complete auth
filler_google_auth({ action: "complete_auth", device_code: "xyz123" })
→ { status: "Authenticated to Google Sheets" }
```

#### Initialize a New Sheet

If the spreadsheet doesn't have `data` and `fields` tabs yet, create them:

```
filler_init()
→ { success: true, fieldsTab: "fields", dataTab: "data", keyField: "name" }
```

This creates both tabs with their header rows. Errors if either tab already exists.

#### Switch to a Different Sheet

To work with a different Google Sheet:

```
filler_use_sheet_id({ sheet_id: "1ABC...xyz" })
# or with full URL:
filler_use_sheet_id({ sheet_id: "https://docs.google.com/spreadsheets/d/1ABC...xyz/edit" })
```

### Main Workflow

#### 1. Understand the Schema

First, get the field definitions to understand what data to collect: `filler_list_fields()`.

Fields with `auto: true` are candidates for auto-filling. Each field has:
- `name` - field identifier
- `type` - validation type (string, number, date, url, email, json, enum:...)
- `instructions` - how to collect this value
- `example` - example value

#### 2. Get an Object

Two options for retrieving objects:

**Option A: Get the next object with missing fields**
```
filler_get_next_missing_fields_objects({ limit: 1 })
```
Returns objects with missing auto fields (default limit 1). If `found: false`, all objects are complete.

Pass `skip_filled_fields: true` to omit already-filled values from `object.values`, reducing response size for sheets with many columns.

**Option B: Get specific objects by name**
```
filler_get_objects_by_name({ names: ["Acme Corp"] })
```
Returns objects with their missing auto fields. Useful when you know which objects to work on.

Option A returns `{ found, objects, count, remain }`. Option B returns `{ objects: [{ found, object, missing }] }`. Both provide object data and fields that need filling.

#### 3. Collect Values

For each missing field, follow the `instructions` to collect the value. Ensure values match the field `type`: 

| Type | Format |
|------|--------|
| `string` | Any text |
| `number` | Numeric value |
| `date` | `YYYY-MM-DD` |
| `datetime` | ISO-8601 |
| `url` | Full URL with protocol |
| `email` | Valid email address |
| `json` | Valid JSON string |
| `enum:a\|b\|c` | One of the listed values |

#### 4. Save Values

Save collected values (won't overwrite existing data):

```
filler_save_objects_no_overwrite({
  objects: [{
    name: "Acme Corp",
    values: {
      "website": "https://acme.com",
      "founded": "1990"
    }
  }]
})
```

Check the result for each field:
- `saved` - value was stored
- `skipped_already_set` - field already has a value (not overwritten)
- `rejected_unknown_field` - field not in schema
- `rejected_invalid_type` - value failed type validation

#### 5. Repeat

Continue with step 2 until no missing auto fields remain.

## Creating New Data

### Add Fields

```
filler_add_fields({
  fields: [{
    name: "revenue",
    description: "Annual revenue",
    type: "number",
    auto: true,
    instructions: "Find the company's annual revenue in USD",
    example: "1000000"
  }]
})
```

### Add Objects

```
filler_add_objects_by_name({ names: ["New Company"] })
```

## Example Session

```
# 1. Check schema
filler_list_fields()
→ fields: [name, website (auto), email (auto), founded]

# 2. Get object
filler_get_next_missing_fields_objects({ limit: 1 })
→ { found: true, objects: [{ object: { name: "Acme Corp" }, missing: [{ name: "website", type: "url", instructions: "Find official website" }] }], count: 1, remain: 0 }

# 2b. Or get a specific object
filler_get_objects_by_name({ names: ["Acme Corp"] })
→ { objects: [{ found: true, object: { name: "Acme Corp" }, missing: [{ name: "website", ... }] }] }

# 3. Collect and save
filler_save_objects_no_overwrite({ objects: [{ name: "Acme Corp", values: { website: "https://acme.com" } }] })
→ result: { website: "saved" }

## Key Rules

1. **Never guess values** - only save data you have verified
2. **Check field types** - ensure values match the expected format before saving
3. **Trust the no-overwrite** - the server protects existing data, but don't rely on this as a crutch
4. **Follow instructions** - each field's `instructions` describe how to collect that specific value
5. **Handle rejections** - if a value is rejected, check the type and fix accordingly
