const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();

const PORT = 3001;

const ISSUES_FILE = path.join(
  __dirname,
  'src',
  'data',
  'issues.json'
);

app.use(express.json({ limit: '5mb' }));

// =========================================================
// GET issues.json
// =========================================================

app.get('/api/issues', async (req, res) => {
  try {
    const file = await fs.readFile(
      ISSUES_FILE,
      'utf8'
    );

    res.json(JSON.parse(file));
  } catch (error) {
    console.error(
      'Failed to read issues.json:',
      error
    );

    res.status(500).json({
      error:
        'Unable to read issues.json',
    });
  }
});

// =========================================================
// PUT issues.json
// =========================================================

app.put('/api/issues', async (req, res) => {
  try {
    if (!Array.isArray(req.body)) {
      return res.status(400).json({
        error:
          'Request body must be a JSON array.',
      });
    }

    // Validate that every item looks like an issue.
    const invalidIssue =
      req.body.find(
        (issue) =>
          !issue ||
          typeof issue !== 'object' ||
          typeof issue.issue_type !==
            'string' ||
          typeof issue.summary !==
            'string'
      );

    if (invalidIssue) {
      return res.status(400).json({
        error:
          'Invalid issue format.',
      });
    }

    // Pretty-print exactly like your current file.
    const json =
      JSON.stringify(
        req.body,
        null,
        2
      ) + '\n';

    await fs.writeFile(
      ISSUES_FILE,
      json,
      'utf8'
    );

    res.json({
      success: true,
      count: req.body.length,
      file: ISSUES_FILE,
    });
  } catch (error) {
    console.error(
      'Failed to write issues.json:',
      error
    );

    res.status(500).json({
      error:
        'Unable to write issues.json.',
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `Issue API running on http://localhost:${PORT}`
  );

  console.log(
    `Reading/writing: ${ISSUES_FILE}`
  );
});
