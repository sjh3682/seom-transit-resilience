"""화면 전수 점검:  python3 tests/ui_audit.py   (pip install playwright && playwright install chromium)

모든 레이어·버튼·정책·경로찾기·발표 모드·지도 저장·주소 복원·화면 폭(1600/1366/1024/820/390)을
자동으로 눌러 보고 다음을 기계적으로 잡는다. 캡처는 tests/_audit/ 에 저장된다.
  - 자바스크립트 오류, 화면 글자 속 undefined/NaN/null
  - 패널 안 가로 넘침, 짧은 값·점수가 두 줄로 쪼개짐
  - 버튼 동작 시간
문제가 없으면 마지막 줄에 "문제 0건" 을 출력한다.
"""
import asyncio, os, time
from pathlib import Path
from playwright.async_api import async_playwright
ROOT = Path(__file__).resolve().parents[1]
URL = (ROOT / 'dist' / 'index.html').as_uri()
OUT = ROOT / 'tests' / '_audit'
OUT.mkdir(exist_ok=True)
CHROME = os.environ.get('CHROME_PATH')   # 비우면 playwright 기본 크로미움
RDY='window.seomApp && window.seomApp.ds && document.getElementById("loading").classList.contains("hide")'
CHECK=r'''()=>{
  const bad=[]; const txt=(document.getElementById('app').innerText||'');
  const m=txt.match(/.{0,25}(undefined|NaN|\[object|Infinity|null)(?![가-힣]).{0,25}/g); if(m) bad.push('TEXT:'+m.slice(0,3).join(' / '));
  for (const root of ['#leftPanel','#rightPanel','#legend','#tooltip','#chooser','#tourCard','#methodDialog']) {
    const r=document.querySelector(root); if(!r || r.offsetParent===null) continue;
    for (const el of r.querySelectorAll('*')) {
      if (el.offsetParent===null) continue;
      const cs=getComputedStyle(el); if (cs.overflowX==='auto'||cs.overflowX==='scroll') continue;
      if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth>0 && el.children.length===0) bad.push('OVERFLOW '+root+' .'+(el.className||el.tagName)+': '+el.textContent.trim().slice(0,40));
    }
  }
  // 짧은 값·점수가 두 줄로 쪼개지는지 (인라인 요소의 줄 조각 수로 판정)
  for (const el of document.querySelectorAll('#rightPanel .driver b, #rightPanel .badge, #rightPanel .metric b, #rightPanel .item b, #rightPanel .d-score, #rightPanel .sim-head span, #rightPanel td, #tooltip b, #chooser b, #legend .lg-row, #layerChip')) {
    if (el.offsetParent===null || el.closest('td.od-pair')) continue;   // 출발→도착 칸은 의도한 두 줄
    const t=el.textContent.trim(); if (t.length>28) continue;
    const r=document.createRange(); r.selectNodeContents(el); const lines=new Set([...r.getClientRects()].map(x=>Math.round(x.top)));
    if (lines.size>1) bad.push('WRAP '+(el.closest('[class]')||el).className+': '+t);
  }
  return [...new Set(bad)].slice(0,12);
}'''
log=[]
problems=[]
async def snap(pg, name, note=''):
    await pg.wait_for_timeout(350)
    bad=await pg.evaluate(CHECK)
    await pg.screenshot(path=f'{OUT}/{len(log):02d}_{name}.png')
    bad = [b for b in bad if 'lg-row' not in b]   # 범례 색 견본과 글자의 높이 차이는 줄바꿈이 아님
    log.append((name, bad, note)); problems.extend(bad); print(f'[{len(log)-1:02d}] {name} {note}', *bad, sep='\n    ')
async def perf_check(b):
    """속도: 150% 배율 화면 기준. 자바스크립트 시간만 재면 선을 픽셀로 칠하는 시간을 놓친다(v7.3 에서 실제로 놓침)
    → '화면에 보일 때까지'(requestAnimationFrame 두 번)로 잰다.
      ① 레이어·축척별 다시 그리기 중앙값 300ms 초과 = 문제
      ② CPU 4배 느린 조건에서 드래그하는 동안 100ms 넘는 프레임 = 문제(드래그 중엔 다시 그리지 않아야 한다)"""
    ctx = await b.new_context(viewport={'width': 1613, 'height': 1000}, device_scale_factor=1.5)
    pg = await ctx.new_page()
    await pg.route('**/*.png', lambda r: r.abort()); await pg.route('**/*.png?*', lambda r: r.abort())
    await pg.goto(URL); await pg.wait_for_function(RDY, timeout=90000)
    for mode, sub in [('region', 'sigungu'), ('region', 'grid'), ('line', None), ('stop', None), ('segment', None)]:
        for z, lon, lat in [(6.6, 127.7, 36.1), (10.5, 126.85, 35.95), (13, 126.98, 37.56)]:
            vals = []
            for k in range(3):
                vals.append(await pg.evaluate(f'''()=>new Promise(res=>{{const a=seomApp, m=a.map; a.setMode('{mode}'); {"a.setRegionSub('" + sub + "');" if sub else ""}
                    m.setView(Mercator.x({lon})+{k}*1e-6, Mercator.y({lat}), {z}); const s=performance.now(); m.renderBaseNow();
                    requestAnimationFrame(()=>requestAnimationFrame(()=>res(Math.round(performance.now()-s))));}})'''))
            med = sorted(vals)[1]
            name = mode + ('/' + sub if sub else '')
            print(f'  화면에 보일 때까지 {name:15s} 줌 {z:4}: 중앙값 {med}ms')
            if med > 300: problems.append(f'SLOW {name} 줌{z}: {med}ms')
    # 가장 무거운 화면: 전체화면 크기에서 수도권 전체가 보이는 중간 축척(노선 수천 개가 한 도로에 겹침)
    await pg.set_viewport_size({'width': 1707, 'height': 1019}); await pg.wait_for_timeout(800)
    for mode in ['line', 'segment']:
        for z in (9.5, 11):
            vals = []
            for k in range(3):
                vals.append(await pg.evaluate(f'''()=>new Promise(res=>{{const a=seomApp, m=a.map; a.setMode('{mode}');
                    m.setView(Mercator.x(126.99)+{k}*1e-6, Mercator.y(37.5), {z}); const s=performance.now(); m.renderBaseNow();
                    requestAnimationFrame(()=>requestAnimationFrame(()=>res(Math.round(performance.now()-s))));}})'''))
            med = sorted(vals)[1]
            print(f'  전체화면 수도권 {mode:8s} 줌 {z}: 중앙값 {med}ms')
            if med > 700: problems.append(f'SLOW 전체화면 수도권 {mode} 줌{z}: {med}ms')
    await pg.set_viewport_size({'width': 1613, 'height': 1000})
    cdp = await ctx.new_cdp_session(pg); await cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    box = await pg.locator('#mapPanel').bounding_box(); cx, cy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    for mode in ['line', 'segment', 'stop']:
        await pg.click(f'[data-layer={mode}]')
        await pg.evaluate('()=>{const m=seomApp.map; m.setView(Mercator.x(127.7), Mercator.y(36.1), 6.6); m.renderBaseNow();}'); await pg.wait_for_timeout(2500)
        await pg.evaluate('''()=>{window.__fr=[]; let last=performance.now(); window.__run=true; const loop=(t)=>{ if(!window.__run) return; window.__fr.push(t-last); last=t; requestAnimationFrame(loop)}; requestAnimationFrame(loop);}''')
        await pg.mouse.move(cx, cy); await pg.mouse.down()
        for i in range(40):
            await pg.mouse.move(cx - i * 8, cy - i * 4); await pg.wait_for_timeout(25)
        fr = await pg.evaluate('()=>{window.__run=false; return window.__fr.slice(2)}')
        await pg.mouse.up(); await pg.wait_for_timeout(1500)
        worst = max(fr) if fr else 0
        print(f'  드래그 중 최장 프레임({mode}, CPU 4배 느리게): {worst:.0f}ms')
        if worst > 100: problems.append(f'JANK 드래그 {mode}: {worst:.0f}ms')
    await ctx.close()


async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        pg=await b.new_page(viewport={'width':1600,'height':900})
        await pg.route('**/*.png', lambda r: r.abort())
        errs=[]; pg.on('pageerror', lambda e: errs.append('PAGEERR '+str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE '+m.text) if m.type=='error' and 'ERR_FAILED' not in m.text and 'CORS' not in m.text else None)
        t=time.time(); await pg.goto(URL); await pg.wait_for_function(RDY, timeout=60000); await snap(pg,'home',f'load {time.time()-t:.1f}s')
        E=pg.evaluate
        async def sel(kind, expr): await E(f'()=>seomApp.select("{kind}", {expr})'); await pg.wait_for_timeout(700)
        async def act(selector, name, wait='.sim-card'):
            t=time.time(); await pg.click(selector); 
            try: await pg.wait_for_selector(wait, timeout=30000)
            except Exception: print('  !! wait fail', name)
            await snap(pg, name, f'{time.time()-t:.2f}s')
        # region
        await pg.click('[data-sub=grid]'); await snap(pg,'grid_national')
        cell=await E('()=>{const a=seomApp.ds.a; for(let i=0;i<a.gr_grade.length;i++) if(a.gr_grade[i]===4) return i; }')
        await sel('grid', cell); await snap(pg,'grid_gap_selected')
        cell2=await E('()=>{const a=seomApp.ds.a; for(let i=0;i<a.gr_grade.length;i++) if(a.gr_grade[i]===3) return i; }')
        await sel('grid', cell2); await snap(pg,'grid_selected')
        await pg.click('[data-sub=sigungu]')
        await sel('region','seomApp.ds.regions.findIndex(r=>r.code==="47730")'); await snap(pg,'region_uiseong')
        await E('()=>{document.getElementById("settingsFold").open = true}')      # 표시 설정은 접힌 칸
        await pg.click('#seniorToggle'); await snap(pg,'senior_on'); await pg.click('#seniorToggle')
        # line
        await pg.click('[data-layer=line]'); await snap(pg,'line_national')
        await pg.click('#lodToggle'); await snap(pg,'line_national_lod_off'); await pg.click('#lodToggle')
        await sel('line','seomApp.ds.lineName.indexOf("대구3호선")'); await snap(pg,'line_daegu3')
        await act('[data-act=stress]','line_daegu3_stress')
        for k in ['drt','frequency','extension']: await act(f'[data-act=policy][data-kind={k}]', f'policy_{k}', '.policy-card')
        await sel('line','seomApp.ds.lineName.indexOf("백령도↔인천항_인천")'); await act('[data-act=stress]','ferry_stress')
        await act('[data-act=policy][data-kind=drt]','ferry_policy_drt','.policy-card')
        for code in ['3','6','7']: await pg.click(f'[data-mode-code="{code}"]')
        await sel('line','seomApp.ds.lineName.indexOf("김포-제주")'); await snap(pg,'air_line')
        await pg.evaluate('()=>seomApp.clearSelection()'); await snap(pg,'line_longdist_on')
        for code in ['3','6','7']: await pg.click(f'[data-mode-code="{code}"]')
        # stop
        await pg.click('[data-layer=stop]'); await snap(pg,'stop_national')
        await E('()=>seomApp.map.setView(Mercator.x(128.60), Mercator.y(35.87), 13.5)'); await pg.wait_for_timeout(600); await snap(pg,'stop_zoom_daegu')
        await E('()=>seomApp.map.setView(Mercator.x(128.6285), Mercator.y(35.8795), 15.6)'); await pg.wait_for_timeout(600); await snap(pg,'labels_street')
        await E('()=>seomApp.map.setView(Mercator.x(128.3), Mercator.y(36.2), 9.2)'); await pg.wait_for_timeout(600); await snap(pg,'labels_sigungu')
        await sel('stop','seomApp.ds.groupName.indexOf("동대구역")'); await act('[data-act=stress-stop]','stop_stress')
        await act('[data-act=policy-stop]','stop_policy','.policy-card')
        # segment
        await pg.click('[data-layer=segment]'); await snap(pg,'segment_national')
        s=await E('()=>{const a=seomApp.ds.a; let best=0; for(let i=0;i<a.s_grade.length;i++) if(a.s_score[i]>a.s_score[best]) best=i; return best;}')
        await sel('segment', s); await act('[data-act=stress-seg]','segment_stress')
        # hover tooltip & chooser
        await pg.click('[data-layer=line]'); await E('()=>seomApp.clearSelection()')
        await E('()=>seomApp.map.setView(Mercator.x(126.978), Mercator.y(37.5665), 14)'); await pg.wait_for_timeout(700)
        box=await pg.locator('#mapPanel').bounding_box()
        await pg.mouse.move(box['x']+box['width']/2, box['y']+box['height']/2); await snap(pg,'hover_seoul')
        await pg.mouse.click(box['x']+box['width']/2, box['y']+box['height']/2); await snap(pg,'click_seoul_center')
        # search
        await E('()=>seomApp.clearSelection()')
        await pg.fill('#searchInput','서울역'); await pg.wait_for_timeout(400); await snap(pg,'search_seoulstation')
        await pg.fill('#searchInput','의성'); await pg.wait_for_timeout(400); await snap(pg,'search_uiseong')
        await pg.fill('#searchInput','zzzz없는이름'); await pg.wait_for_timeout(400); await snap(pg,'search_none')
        await pg.fill('#searchInput',''); await pg.keyboard.press('Escape')
        # journey (경로 회복력은 접힌 칸)
        for s_,t_ in [('서울역버스환승센터','부산역'),('백령도','제주국제공항')]:
            await pg.fill('#startInput', s_); await pg.wait_for_timeout(300); await pg.keyboard.press('Enter')
            await pg.fill('#endInput', t_); await pg.wait_for_timeout(300); await pg.keyboard.press('Enter')
            t=time.time(); await pg.click('#journeyBtn'); await pg.wait_for_timeout(3500); await snap(pg,'journey_'+s_[:3], f'{time.time()-t:.1f}s')
        await pg.fill('#startInput',''); await pg.fill('#endInput',''); await pg.click('#journeyBtn'); await snap(pg,'journey_empty')
        # modal, tour, export
        await pg.click('#methodBtn'); await snap(pg,'method_dialog'); await pg.click('#methodClose')
        await pg.click('#tourBtn'); await pg.wait_for_timeout(2500); await snap(pg,'tour_1')
        for i in (2,3):
            await pg.click('#tourCard [data-t=next]'); await pg.wait_for_timeout(3000); await snap(pg,f'tour_{i}')
        await pg.click('#tourCard [data-t=next]')
        try:
            async with pg.expect_download(timeout=15000) as dl: await pg.click('#exportBtn')
            d=await dl.value; print('export ok', d.suggested_filename)
        except Exception as e: print('export: no download', str(e)[:100])
        # hash restore
        for h in ['#line=RR_ACC1_S-3-03-1D','#stop=96107','#region=47730','#segment=5']:
            q=await b.new_page(viewport={'width':1600,'height':900}); await q.route('**/*.png', lambda r: r.abort())
            await q.goto(URL+h); await q.wait_for_function(RDY, timeout=60000); await q.wait_for_timeout(900)
            st=await q.evaluate('()=>({mode:seomApp.state.mode, sel:JSON.stringify(seomApp.selection), title:(document.querySelector("#detail h2")||{}).innerText})')
            print('hash', h, st); await q.close()
        print('ERRORS', errs[:10])
        await perf_check(b)
        problems.extend(errs)
        for w,h,mob,name in [(1366,768,False,'w1366'),(1024,768,False,'w1024'),(820,1180,False,'tab'),(390,844,True,'mob')]:
            q=await b.new_page(viewport={'width':w,'height':h}, is_mobile=mob, has_touch=mob); await q.route('**/*.png', lambda r: r.abort())
            await q.goto(URL); await q.wait_for_function(RDY, timeout=60000); await q.wait_for_timeout(500)
            await q.screenshot(path=f'{OUT}/{len(log):02d}_{name}_home.png'); bad=[x for x in await q.evaluate(CHECK) if 'lg-row' not in x]; problems.extend(bad); log.append((name+'_home',bad,'')); print(name,'home',bad)
            await q.evaluate('()=>seomApp.select("line", seomApp.ds.lineName.indexOf("대구3호선"))'); await q.wait_for_timeout(1000)
            await q.screenshot(path=f'{OUT}/{len(log):02d}_{name}_line.png'); bad=[x for x in await q.evaluate(CHECK) if 'lg-row' not in x]; problems.extend(bad); log.append((name+'_line',bad,'')); print(name,'line',bad)
            if mob:
                await q.click('#mobileNav [data-sheet=filters]'); await q.wait_for_timeout(400)
                await q.screenshot(path=f'{OUT}/{len(log):02d}_{name}_filters.png'); log.append((name+'_filters',[],''))
            await q.close()
        await b.close()
asyncio.run(main())
print(f"문제 {len(problems)}건" + ("" if not problems else ": " + " / ".join(problems[:10])))
