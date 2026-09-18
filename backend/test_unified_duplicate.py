import tempfile
import unittest
from pathlib import Path
import numpy as np
import pandas as pd
from story_intelligence import Draft, ReviewRequest, BatchReviewRequest, review_story, review_batch

class Model:
    def encode(self, texts, normalize_embeddings=True):
        vectors = []
        for text in texts:
            t = text.lower()
            if 'cancel' in t or 'withdraw' in t:
                vectors.append([1., 0., 0.])
            elif 'audit' in t:
                vectors.append([0., 1., 0.])
            else:
                vectors.append([0., 0., 1.])
        return np.asarray(vectors)

class UnifiedDuplicateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'dataset.xlsx'
        with pd.ExcelWriter(self.path) as writer:
            pd.DataFrame([
                {'TicketID':'E-1','Title':'Booking','Type':'Epic','ParentID':''},
                {'TicketID':'F-1','Title':'Reservations','Type':'Feature','ParentID':'E-1'},
                {'TicketID':'S-1','Title':'Cancel reservation','Type':'Story','ParentID':'F-1'},
                {'TicketID':'T-1','Title':'Audit report','Type':'Task','ParentID':'F-1'},
            ]).to_excel(writer, sheet_name='Backlog', index=False)
        self.model = Model()
    def tearDown(self): self.temp.cleanup()
    def test_epic_exact_match(self):
        r=review_story(self.path,ReviewRequest(story=Draft(title='Booking',type='Epic')),self.model)
        self.assertEqual(r['decision'],'equivalent')
    def test_different_types_not_duplicates(self):
        r=review_story(self.path,ReviewRequest(story=Draft(title='Booking',type='Story')),self.model)
        self.assertEqual(r['decision'],'new')
    def test_paraphrase_flagged(self):
        r=review_story(self.path,ReviewRequest(story=Draft(title='Withdraw a reservation',type='Story')),self.model)
        self.assertEqual(r['decision'],'needs_review')
        self.assertEqual(r['matches'][0]['id'],'S-1')
    def test_batch_flags_same_import(self):
        r=review_batch(self.path,BatchReviewRequest(tickets=[Draft(id='N-1',title='Create invoices'),Draft(id='N-2',title='Create invoices')]),self.model)
        self.assertEqual(r['results'][1]['decision'],'equivalent')
        self.assertEqual(r['results'][1]['matches'][0]['source'],'same import')
    def test_full_backlog_count_and_parent(self):
        r=review_story(self.path,ReviewRequest(story=Draft(title='Withdraw a reservation',type='Story')),self.model)
        self.assertEqual(r['checked_original_count'],4)
        self.assertEqual(r['suggested_parent_id'],'F-1')
        self.assertEqual(r['suggested_sprint'],'')

if __name__=='__main__': unittest.main()
