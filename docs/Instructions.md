# Sheet Filler — Usage Instructions

## Setup

1. Open or create a Google Sheet with data rows (objects) and column headers (fields).
2. Share the sheet with the service account or authenticate via OAuth.
3. Call `filler_init` to create a "fields" tab from the first tab's column headers.
4. Edit the "fields" tab to set `auto=TRUE` for columns the AI should fill, and add `instructions` describing how to determine each value.

## Workflow

0. Call `filler_use_sheet_id` to switch to the desired Google Sheet.
1. Call `filler_get_next_missing_fields_objects` (default limit 1) to get objects with empty auto-fill fields.
2. Read the field instructions for missing fields.
3. Research or compute the values following those instructions.
4. Call `filler_save_objects_no_overwrite` with `objects: [{ name, values }]` to save values (existing non-empty values are never overwritten).
5. Repeat from step 1 until no more objects need filling.

Use a higher `limit` with `filler_get_next_missing_fields_objects` to get multiple objects at once.

## Main Tools

| Tool | Description |
|------|-------------|
| `filler_use_sheet_id` | Switch to a different Google Sheet |
| `filler_init` | Create fields tab and populate from first tab's column headers |
| `filler_get_next_missing_fields_objects` | Get multiple objects with missing auto-fill fields (batch) |
| `filler_save_objects_no_overwrite` | Save values for multiple objects at once (batch) |
| `filler_add_objects_by_name` | Create new objects (batch) |
| `filler_add_fields` | Add new fields to the schema (batch) |
| `filler_get_objects_by_name` | Get objects by their names with missing auto fields (batch) |

## Field Properties

Each field has: `name` (unique identifier), `description`, `type` (string, number, date, datetime, url, email, json, or enum:val1|val2|val3), `auto` (boolean — whether the AI should fill this field), `instructions` (how to determine the value), and `example`.

## Save Statuses

When saving values, each field returns one of:
- `saved` — value was written successfully
- `skipped_already_set` — field already had a non-empty value (not overwritten)
- `rejected_unknown_field` — field name not found in schema
- `rejected_invalid_type` — value does not match the field's type
