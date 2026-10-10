const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({...(process.env.BROWSER_EXECUTABLE ? {executablePath:process.env.BROWSER_EXECUTABLE} : {}),headless:true});
 const context=await browser.newContext({viewport:{width:1120,height:1080}}),p=await context.newPage(),errors=[];
 p.on('pageerror',e=>errors.push(e.message));
 await p.goto((process.env.RECITE_URL || 'http://localhost:8765/')+'#recite');await p.locator('#reciteMask').waitFor();
 await p.screenshot({path:require('node:os').tmpdir()+'/hifz-recite-ready.png',fullPage:true});
 assert.equal(await p.locator('#reciteTitle').textContent(),'Al-Baqarah');
 await p.locator('#reciteDemo').click();assert.equal(await p.locator('#reciteModeBadge').isVisible(),true);
 for(let i=0;i<3;i++)await p.locator('#reciteDemoNext').click();
 await p.locator('#reciteDemoMistake').click();assert.equal(await p.locator('#reciteCount').textContent(),'3 of 127 words');
 assert.equal(await p.locator('#reciteDemoNext').isDisabled(),true);assert.equal(await p.locator('#reciteReviewList bdi').textContent(),'Hidden word');
 await p.locator('#reciteRetry').click();await p.locator('#reciteDemoNext').click();
 assert.equal(await p.locator('#reciteCount').textContent(),'4 of 127 words');assert.equal(await p.locator('#reciteReviewCount').textContent(),'1 to revisit');
 await p.screenshot({path:require('node:os').tmpdir()+'/hifz-recite-retry.png',fullPage:true});
 await p.locator('#reciteHint').click();assert.equal(await p.locator('#reciteCount').textContent(),'4 of 127 words');
 for(let i=4;i<127;i++)await p.locator('#reciteDemoNext').click();
 assert.equal(await p.locator('#reciteState').textContent(),'Demo complete');await p.screenshot({path:require('node:os').tmpdir()+'/hifz-recite-complete.png',fullPage:true});
 await p.locator('#reciteRestart').click();await p.locator('#reciteReveal').click();assert.equal(await p.locator('#reciteCount').textContent(),'0 of 127 words');
 await p.locator('#reciteRestart').click();
 for(const width of [1120,760,390,320]){
  await p.setViewportSize({width,height:1000});let tabY;
  for(const name of ['test','recite','hifz','mutashabihat','waqf']){
   await p.locator('#'+name+'Tab').click();await p.waitForTimeout(120);
   const m=await p.evaluate(()=>({doc:document.documentElement.scrollWidth,win:innerWidth,y:document.querySelector('.appTabs').getBoundingClientRect().y}));
   assert.ok(m.doc<=m.win,`${width}/${name}: ${m.doc}>${m.win}`);if(tabY===undefined)tabY=m.y;assert.equal(m.y,tabY);
  }
  await p.locator('#reciteTab').click();if(width===390)await p.screenshot({path:require('node:os').tmpdir()+'/hifz-recite-mobile.png',fullPage:true});
 }
 await p.locator('#reciteTab').focus();await p.keyboard.press('End');assert.equal(await p.locator('#waqfTab').getAttribute('aria-selected'),'true');
 await p.keyboard.press('Home');assert.equal(await p.locator('#testTab').getAttribute('aria-selected'),'true');
 await p.keyboard.press('ArrowRight');assert.equal(await p.locator('#reciteTab').getAttribute('aria-selected'),'true');
 assert.deepEqual(errors,[]);console.log('Recite mechanics, mobile tabs, keyboard: passed.');
 await context.close();
 const fc=await browser.newContext(),file=await fc.newPage();
 await file.goto(require('node:url').pathToFileURL(require('node:path').resolve(__dirname,'../../index.html')).href+'#recite');await file.locator('#reciteDemo').click();await file.locator('#reciteDemoNext').click();
 assert.equal(await file.locator('#reciteCount').textContent(),'1 of 127 words');console.log('file:// demo passed');
 await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
