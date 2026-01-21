# SKILL.md - Using sheet-filler MCP Server

This skill describes how to use the `sheet-filler` MCP server for safely auto-filling tabular data.

## Purpose

The sheet-filler server manages objects (rows) with fields (columns). It prevents overwriting existing values, making it safe for incremental data collection.

## Tools Reference

### filler_list_fields

List all fields or a subset by names.

| Input | Type | Description |
|-------|------|-------------|
| `names` | `string[]` | Optional. Filter by field names |
| `include_instructions` | `boolean` | Include instructions (default: true) |

**Output:** `{ fields: Field[] }`

### filler_get_fields_by_names

Get field metadata by list of names.

| Input | Type | Description |
|-------|------|-------------|
| `names` | `string[]` | Required. Field names to retrieve |
| `include_instructions` | `boolean` | Include instructions (default: true) |

**Output:** `{ fields: Field[] }`

### filler_add_field

Add a new field to the schema.

| Input | Type | Description |
|-------|------|-------------|
| `field.name` | `string` | Required. Unique field name |
| `field.description` | `string` | Field description |
| `field.type` | `string` | Data type for validation |
| `field.auto` | `boolean` | Mark as auto-fill field |
| `field.instructions` | `string` | Instructions for auto-filling |
| `field.example` | `string` | Example value |

**Output:** `{ created: boolean, field: Field }`

### filler_get_object

Get an object by its identifier.

| Input | Type | Description |
|-------|------|-------------|
| `id` | `string` | Required. Object identifier |

**Output:** `{ found: boolean, object?: { name, values } }`

### filler_get_object_by_name

Get an object by its name (key field).

| Input | Type | Description |
|-------|------|-------------|
| `name` | `string` | Required. Object name |

**Output:** `{ found: boolean, object?: { name, values } }`

### filler_add_object_by_name

Create a new object with the given name.

| Input | Type | Description |
|-------|------|-------------|
| `name` | `string` | Required. Name for the new object |

**Output:** `{ created: boolean, object: { name } }`

### filler_save_object_no_overwrite

Save field values without overwriting existing non-empty values.

| Input | Type | Description |
|-------|------|-------------|
| `name` | `string` | Required. Object name |
| `values` | `Record<string, string>` | Required. Field values to save |

**Output:** `{ result: Record<string, SaveStatus> }`

SaveStatus values:
- `saved` - value was stored
- `skipped_already_set` - field already has a value
- `rejected_unknown_field` - field not in schema
- `rejected_invalid_type` - value failed type validation

### filler_get_missing_auto_fields

Get list of auto-fill fields that are empty for an object.

| Input | Type | Description |
|-------|------|-------------|
| `name` | `string` | Required. Object name |
| `include_field_meta` | `boolean` | Include field metadata (default: true) |

**Output:** `{ missing: Array<{ name, type?, example?, instructions? }> }`

### filler_get_next_missing_fields_object

Get the first object that has missing auto-fill fields.

| Input | Type | Description |
|-------|------|-------------|
| `include_field_meta` | `boolean` | Include field metadata (default: true) |

**Output:** `{ found: boolean, object?: { name, values }, missing?: Array<{ name, type?, example?, instructions? }> }`

## Workflow

### Quick Start: Process Next Object

Use `filler_get_next_missing_fields_object` to find the next object needing work:

```
filler_get_next_missing_fields_object()
```

This returns the first object with missing auto fields, along with what needs to be filled. If `found: false`, all objects are complete.

### Manual Workflow

#### 1. Understand the Schema

First, get the field definitions to understand what data to collect:

```
filler_list_fields()
```

Fields with `auto: true` are candidates for auto-filling. Each field has:
- `name` - field identifier
- `type` - validation type (string, number, date, url, email, json, enum:...)
- `instructions` - how to collect this value
- `example` - example value

#### 2. Get an Object

Retrieve the object you need to fill:

```
filler_get_object_by_name({ name: "Acme Corp" })
```

#### 3. Find Missing Auto Fields

Get the list of empty auto-fill fields for this object:

```
filler_get_missing_auto_fields({ name: "Acme Corp" })
```

This returns only `auto: true` fields that are currently empty, with their instructions.

#### 4. Collect Values

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

#### 5. Save Values

Save collected values (won't overwrite existing data):

```
filler_save_object_no_overwrite({
  name: "Acme Corp",
  values: {
    "website": "https://acme.com",
    "founded": "1990"
  }
})
```

Check the result for each field:
- `saved` - value was stored
- `skipped_already_set` - field already has a value (not overwritten)
- `rejected_unknown_field` - field not in schema
- `rejected_invalid_type` - value failed type validation

#### 6. Repeat

Continue with step 3 until no missing auto fields remain.

## Creating New Data

### Add a Field

```
filler_add_field({
  field: {
    name: "revenue",
    description: "Annual revenue",
    type: "number",
    auto: true,
    instructions: "Find the company's annual revenue in USD"
  }
})
```

### Add an Object

```
filler_add_object_by_name({ name: "New Company" })
```

## Example Session

```
# 1. Check schema
filler_list_fields()
→ fields: [name, website (auto), email (auto), founded]

# 2. Get object
filler_get_object_by_name({ name: "Acme Corp" })
→ { name: "Acme Corp", values: { email: "info@acme.com" } }

# 3. Find what's missing
filler_get_missing_auto_fields({ name: "Acme Corp" })
→ missing: [{ name: "website", type: "url", instructions: "Find official website" }]

# 4. Collect and save
filler_save_object_no_overwrite({
  name: "Acme Corp",
  values: { website: "https://acme.com" }
})
→ result: { website: "saved" }

# 5. Verify completion
filler_get_missing_auto_fields({ name: "Acme Corp" })
→ missing: []
```

## Key Rules

1. **Never guess values** - only save data you have verified
2. **Check field types** - ensure values match the expected format before saving
3. **Trust the no-overwrite** - the server protects existing data, but don't rely on this as a crutch
4. **Follow instructions** - each field's `instructions` describe how to collect that specific value
5. **Handle rejections** - if a value is rejected, check the type and fix accordingly
