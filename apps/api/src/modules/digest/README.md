# Digest Module

Generates daily email digests grouped by actionability and exports to Obsidian-compatible markdown.

## Overview

The digest module provides:

1. **Email Grouping**: Automatically categorizes classified emails into three groups:
   - **Actionable**: Items requiring user action (needs_attention, high importance, reply needed)
   - **FYI**: Informational items (newsletters, receipts, notifications)
   - **Low Value**: Items safe to archive or delete (social, promotional, low importance)

2. **Markdown Export**: Generates Obsidian-compatible markdown files with:
   - Date-based filenames (idempotent: same date = same file)
   - Hierarchical structure with summary and grouped sections
   - Review status indicators (✓ approved, ✗ rejected, ? unreviewed/low confidence)

3. **API Endpoints**:
   - `GET /digest` - Returns digest as JSON
   - `POST /digest/generate` - Generates and saves markdown file

## API Usage

### Get Digest (JSON)

```bash
# Get today's digest
curl http://localhost:3000/digest

# Get digest for specific date
curl "http://localhost:3000/digest?date=2025-04-12"
```

### Generate and Save Digest

```bash
# Generate digest and save to Obsidian vault
curl -X POST http://localhost:3000/digest/generate \
  -H "Content-Type: application/json" \
  -d '{
    "outputPath": "/Users/name/Documents/ObsidianVault/DailyNotes",
    "date": "2025-04-12",
    "includeUnreviewed": true
  }'
```

**Parameters:**

- `outputPath` (required): Directory where markdown file will be written
- `date` (optional): ISO 8601 date string (defaults to today)
- `includeUnreviewed` (optional): Include unreviewed classifications (default: true)

## Grouping Logic

### Actionable

Emails that require user attention:

- `needs_attention` category
- `personal` category with `high`/`critical` importance
- `reply_needed` or `read_now` recommended actions
- `immediate` or `today` urgency with `high` importance

### FYI

Informational emails (default group):

- `newsletter`, `receipt`, `notification` categories
- `read_later` category
- Medium/low importance items

### Low Value

Emails safe to batch process:

- `archive`, `delete`, `social`, `unknown` categories
- Low importance with `no_action`, `mark_read`, or `delete` actions

## File Output

### Filename Format

```
email-digest-{YYYY-MM-DD}.md
```

Example: `email-digest-2025-04-12.md`

### Output Structure

```markdown
# Email Digest - 2025-04-12

_Generated at 4/12/2025, 10:30:00 AM_

## Summary

- **Total Emails**: 15
- **Actionable**: 3 items requiring attention
- **FYI**: 8 informational items
- **Low Value**: 4 items to archive/delete

## Actionable

- **Sender Name** - Email subject line ✓

## FYI

- **Sender Name** - Email subject line

## Low Value

- **Sender Name** - Email subject line ✗
```

### Review Status Indicators

- `✓` - Classification was approved
- `✗` - Classification was rejected
- `?` - Unreviewed with low confidence
- (no indicator) - Unreviewed with medium/high confidence

## Obsidian Integration

The markdown output is designed for Obsidian vaults:

1. **Daily Notes**: Configure Obsidian's Daily Notes plugin to link to digest files
2. **Backlinks**: Email subjects create implicit connections
3. **Search**: Standard markdown allows full-text search
4. **Templating**: Simple structure makes it easy to customize with CSS snippets

### Example Workflow

```bash
# Add to cron for daily generation at 8am
0 8 * * * curl -X POST http://localhost:3000/digest/generate \
  -H "Content-Type: application/json" \
  -d '{"outputPath": "/path/to/vault/DailyNotes"}'
```

## Verification Steps

1. **Start the server:**

   ```bash
   pnpm --filter @email-ai/api start:dev
   ```

2. **Test the JSON endpoint:**

   ```bash
   curl http://localhost:3000/digest
   ```

3. **Test file generation:**

   ```bash
   curl -X POST http://localhost:3000/digest/generate \
     -H "Content-Type: application/json" \
     -d '{"outputPath": "/tmp/test-digests"}'
   ```

4. **Verify the output:**
   ```bash
   ls -la /tmp/test-digests/
   cat /tmp/test-digests/email-digest-*.md
   ```

## Design Decisions

1. **Idempotent Output**: Same date always produces the same filename, allowing easy overwriting
2. **No External APIs**: File system only - no cloud storage dependencies
3. **Configurable Path**: Output directory is configurable per-request for multi-vault setups
4. **Review Awareness**: Shows review status to help prioritize which emails to trust
5. **Grouped Display**: Three simple groups vs. many categories for faster decision-making
