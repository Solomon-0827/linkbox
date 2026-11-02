import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
from unittest.mock import patch
import network_check as n

class ReportTests(unittest.TestCase):
    def test_report_stays_in_memory(self):
        announced=threading.Event();urls=[]
        def output(value,**kwargs):
            if str(value).startswith('浏览器检测页面：'):
                urls.append(value.split('：',1)[1]);announced.set()
        with tempfile.TemporaryDirectory() as temp,patch.object(n,'BASE',Path(temp)),patch.object(n,'native_checks',return_value={'test':True}),patch.object(n.subprocess,'run'),patch.object(n.time,'sleep'),patch('builtins.print',side_effect=output):
            worker=threading.Thread(target=n.main,daemon=True);worker.start()
            self.assertTrue(announced.wait(3))
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(urls[0],timeout=3) as response:
                page=response.read().decode();self.assertIn('下载报告',page);self.assertIn('URL.createObjectURL',page)
            req=urllib.request.Request(urls[0]+'browser',data=b'{"test":true}',headers={'Content-Type':'application/json'})
            with opener.open(req,timeout=3):pass
            worker.join(5);self.assertFalse(worker.is_alive())
            self.assertEqual(list(Path(temp).rglob('*')),[])
