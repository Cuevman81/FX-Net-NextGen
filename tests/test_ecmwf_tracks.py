"""api/_ecmwf_tracks.py against real ECMWF open-data track files.

The fixtures are cut from the 2026-10-07 00Z/06Z files: Isaias (09L) from the
AIFS ENS (compressed, 52 subsets) and IFS ENS (compressed, no 001030 header)
files, and two storms from the AIFS Single file (uncompressed). Before these
were saved, the stdlib decoder matched pybufrkit on every value of all 2,882
tracks in those three full files; the numbers below are pybufrkit's.

Run: python -m unittest discover -s tests -p 'test_*.py'
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'api'))
import _ecmwf_tracks as et  # noqa: E402


def fixture(name):
    with open(os.path.join(HERE, 'fixtures', name), 'rb') as f:
        return f.read()


class DecodeTests(unittest.TestCase):
    def test_uncompressed_single_run_and_storm_filter(self):
        blob = fixture('ecmwf_aifs_single_2026100706.bufr')
        self.assertEqual(len(et.split_messages(blob)), 2)
        tracks = et.storm_tracks(blob, '09L')
        self.assertEqual(len(tracks), 1)
        t = tracks[0]
        self.assertEqual((t['model'], t['storm'], t['name'], t['member'], t['dtg']),
                         ('AIFS Single', '09L', 'ISAIAS', 52, '2026100706'))
        self.assertEqual(t['points'][0], (0, 21.5, -94.5, 1006.0, 14.4))   # analysed centre at t=0
        self.assertEqual(t['points'][-1], (84, 34.2, -88.6, 1001.0, 9.3))
        self.assertEqual(et.storm_tracks(blob, '18E')[0]['storm'], '18E')
        self.assertEqual(et.storm_tracks(blob, '99L'), [])

    def test_compressed_ai_ensemble(self):
        tracks = et.storm_tracks(fixture('ecmwf_aifs_ens_2026100700_09L.bufr'), '09L')
        self.assertEqual(len(tracks), 52)
        self.assertEqual(sorted(t['member'] for t in tracks), list(range(1, 53)))
        first = next(t for t in tracks if t['member'] == 1)
        self.assertEqual(first['points'][0], (0, 20.9, -95.5, 1005.0, 14.4))
        self.assertEqual(first['points'][-1], (84, 32.2, -87.0, 1003.0, 12.9))
        control = next(t for t in tracks if t['member'] == 51)
        self.assertEqual(control['points'][1], (6, 21.5, -94.3, 1006.0, 14.4))

    def test_physics_ensemble_without_model_name_header(self):
        tracks = et.storm_tracks(fixture('ecmwf_ifs_ens_2026100700_09L.bufr'), '09L')
        self.assertEqual(len(tracks), 51)
        first = next(t for t in tracks if t['member'] == 1)
        self.assertIsNone(first['model'])
        self.assertEqual(first['points'][0], (0, 20.8, -95.8, 1005.0, 15.4))
        self.assertEqual(first['points'][-1], (102, 33.8, -88.9, 1000.0, 11.3))


class AdeckTests(unittest.TestCase):
    def test_single_run_becomes_aifs_rows_in_knots_and_mb(self):
        tracks = et.storm_tracks(fixture('ecmwf_aifs_single_2026100706.bufr'), '09L')
        lines, n = et.to_adeck('aifs', 'al092026', tracks)
        self.assertEqual(n, 0)
        self.assertEqual(lines[0], 'AL, 09, 2026100706, 03, AIFS, 0, 215N, 945W, 28, 1006')

    def test_ensemble_numbering_control_and_mean(self):
        tracks = et.storm_tracks(fixture('ecmwf_aifs_ens_2026100700_09L.bufr'), '09L')
        lines, n = et.to_adeck('aifs-ens', 'al092026', tracks)
        techs = {ln.split(', ')[4] for ln in lines}
        self.assertIn('AF00', techs)          # member 51 is the control
        self.assertIn('AF50', techs)
        self.assertIn('AFMN', techs)
        self.assertNotIn('AF52', techs)       # 52 is the deterministic run, shown elsewhere
        self.assertEqual(n, len([t for t in tracks if 1 <= t['member'] <= 51 and len(t['points']) >= 2]))

    def test_mean_stops_when_fewer_than_half_the_members_remain(self):
        def trk(taus):
            return {'points': [(t, 25.0, -90.0 + t / 100, 1000.0, 20.0) for t in taus]}
        members = [trk([0, 6, 12, 18])] * 3 + [trk([0, 6])] * 3
        mean = et.ensemble_mean(members)
        self.assertEqual([p[0] for p in mean], [0, 6, 12, 18])
        members = [trk([0, 6, 12])] * 2 + [trk([0, 6])] * 5
        self.assertEqual([p[0] for p in et.ensemble_mean(members)], [0, 6])

    def test_mean_handles_the_dateline(self):
        a = {'points': [(0, 20.0, 179.0, None, None)]}
        b = {'points': [(0, 20.0, -179.0, None, None)]}
        lon = et.ensemble_mean([a, b])[0][2]
        self.assertAlmostEqual(abs(lon), 180.0)


class RunDiscoveryTests(unittest.TestCase):
    def test_candidates_walk_back_by_synoptic_time_and_forecast_length(self):
        import datetime
        now = datetime.datetime(2026, 10, 7, 14, 20, tzinfo=datetime.timezone.utc)
        urls = list(et._candidate_urls('ifs-ens', now))
        self.assertEqual(urls[0][0], '2026100712')
        self.assertTrue(urls[0][1].endswith('/20261007/12z/ifs/0p25/enfo/20261007120000-360h-enfo-tf.bufr'))
        self.assertTrue(urls[1][1].endswith('-144h-enfo-tf.bufr'))
        self.assertEqual(urls[2][0], '2026100706')

    def test_rejects_unknown_models_and_ids(self):
        with self.assertRaises(ValueError):
            et.fetch('gfs', 'al092026')
        with self.assertRaises(ValueError):
            et.fetch('aifs', '../etc/passwd')


if __name__ == '__main__':
    unittest.main()
