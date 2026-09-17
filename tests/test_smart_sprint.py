import sys
from pathlib import Path
from datetime import date
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.smart_sprint import PreviewRequest, plan

def req(tickets, dependencies=(), sprints=None, holidays=(), velocity=None):
    return PreviewRequest(tickets=tickets,dependencies=list(dependencies),sprints=sprints or [dict(id=i,name=str(i),start=date(2026,10,1+(i-1)*14),end=date(2026,10,14+(i-1)*14),capacity_points=10) for i in (1,2)],holidays=list(holidays),velocity_points=velocity or {'default':10})

def test_dependency_order():
    result=plan(req([dict(id='wire',points=5),dict(id='html',points=5)], [('wire','html')]))
    assert result['assignments']=={'wire':1,'html':2}

def test_cycle_rejected():
    import pytest
    with pytest.raises(ValueError,match='cycle'):
        plan(req([dict(id='a',points=1),dict(id='b',points=1)],[('a','b'),('b','a')]))

def test_holiday_reduces_capacity():
    s=[dict(id=1,name='S1',start='2026-10-05',end='2026-10-16',capacity_points=10)]
    result=plan(req([dict(id='a',points=10)],sprints=s,holidays=['2026-10-05']))
    assert result['unscheduled']==['a']
    assert result['capacity'][0]['effective_capacity']==9

def test_committed_never_moved():
    result=plan(req([dict(id='locked',points=5,current_sprint_id=1,committed=True),dict(id='new',points=7)],sprints=[dict(id=1,name='S1',start='2026-10-01',end='2026-10-14',capacity_points=10,committed=True),dict(id=2,name='S2',start='2026-10-15',end='2026-10-28',capacity_points=10)]))
    assert result['assignments']['locked']==1
    assert result['assignments']['new']==2
    assert all(c['ticket_id']!='locked' for c in result['changes'])

def test_cross_team_dependency():
    s=[dict(id=1,name='A1',start='2026-10-01',end='2026-10-14',capacity_points=10,team='A'),dict(id=2,name='B1',start='2026-10-01',end='2026-10-14',capacity_points=10,team='B'),dict(id=3,name='B2',start='2026-10-15',end='2026-10-28',capacity_points=10,team='B')]
    result=plan(req([dict(id='api',points=2,team='A'),dict(id='ui',points=2,team='B')],[('api','ui')],sprints=s))
    assert result['assignments']=={'api':1,'ui':3}

def test_invalid_dependency():
    import pytest
    with pytest.raises(ValueError,match='Invalid dependency'):
        plan(req([dict(id='a',points=1)],[('missing','a')]))
