import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock
import numpy as np
import pandas as pd
from story_intelligence import Draft, ReviewRequest, review_story

class FakeModel:
    def encode(self, texts, normalize_embeddings=True):
        # Deterministic vectors for testing; no network/model download.
        values = {"Cancel reservation": [1., 0.], "Allow customer to cancel a booking": [0.9, 0.436],
                  "Export audit log": [0., 1.], "Create payment gateway": [-1., 0.]}
        return np.array([values.get(t, [0., 1.]) for t in texts])

class StoryReviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'dataset.xlsx'
        with pd.ExcelWriter(self.path) as writer:
            pd.DataFrame([{'TicketID':'T-1','Type':'Story','Title':'Cancel reservation','ParentID':'F-1'},
                          {'TicketID':'T-2','Type':'Story','Title':'Export audit log','ParentID':'F-2'}]).to_excel(writer,sheet_name='Backlog',index=False)
        self.model = FakeModel()
    def tearDown(self): self.tmp.cleanup()
    def test_exact_equivalent_blocks(self):
        result=review_story(self.path,ReviewRequest(story=Draft(title='Cancel reservation')),self.model)
        self.assertEqual(result['decision'],'equivalent');self.assertEqual(result['matches'][0]['id'],'T-1')
    def test_paraphrase_requires_review(self):
        result=review_story(self.path,ReviewRequest(story=Draft(title='Allow customer to cancel a booking')),self.model)
        self.assertEqual(result['decision'],'needs_review')
    def test_new_is_unscheduled(self):
        result=review_story(self.path,ReviewRequest(story=Draft(title='Create payment gateway')),self.model)
        self.assertEqual(result['decision'],'new');self.assertEqual(result['suggested_sprint'],'')
    def test_local_draft_included(self):
        result=review_story(self.path,ReviewRequest(story=Draft(title='Create payment gateway'),local_drafts=[Draft(id='draft-1',title='Create payment gateway')]),self.model)
        self.assertEqual(result['decision'],'equivalent');self.assertEqual(result['matches'][0]['source'],'approved local draft')
    def test_self_draft_excluded(self):
        result=review_story(self.path,ReviewRequest(story=Draft(id='draft-1',title='Create payment gateway'),local_drafts=[Draft(id='draft-1',title='Create payment gateway')]),self.model)
        self.assertEqual(result['decision'],'new')

if __name__ == '__main__': unittest.main()
