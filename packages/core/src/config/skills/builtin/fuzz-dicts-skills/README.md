# fuzzDicts
Web Pentesting Fuzz dictionaries — this is all you need.

## log 

Updated irregularly. It is recommended to run a git pull before use to stay in sync.


  **To share a dictionary, just submit a PR directly.** 

20210608:

* Added all the payloads mentioned in [Remote Code Execution ( Unix and Windows )](https://ansar0047.medium.com/remote-code-execution-unix-and-windows-4ed3367158b3) under the rcePayloads dictionary.

20201202:

* Updated an admin directory variant provided by [Se7en](https://github.com/r00tSe7en) under the directory dictionary.

20200510:

* Added the pinyin of the top 3000 Chinese surnames to the username dictionary — 188 entries after dedup. Attack!!!.


20200420:

* Merged a PR submitted by [lanyi1998](https://github.com/lanyi1998): top 300+ commonly used mobile phone numbers, placed in the username dictionary — worth a try when you hit a bottleneck. Also added a weak-password dictionary for a certain enterprise group, provided by team member Child.

20200410:

* Added file listings for the /etc/ directory of CentOS and AIX hosts, placed in the ssrfDict directory. Encountered in real-world engagements — AIX differs quite a lot from other systems; figure out the use yourself.

20200406:

* Merged a PR submitted by [lewiswu1209](https://github.com/lewiswu1209): password top 19576.


20200221:

* Updated the webshell password dictionary enhanced by [makoto56](https://github.com/makoto56). I'm leaving my job to study, and won't have many web testing tasks before graduation (and don't really want to keep doing web pentesting), so dictionary updates will slow down a lot. If anyone wants to help maintain it, feel free to contact me.

20200211:

* Added an IoT dictionary, sourced from 500k internet IoT device weak passwords that someone shared in a Telegram group, extracted by [sunu11](https://github.com/sunu11), with domestic data added on top. When you run into an unknown device, just hammer away. Good dictionaries make the job twice as easy.

20200115:

* Added Burp's official 210 payloads to the XSS dictionary, placed in the [burpXssPayload.txt](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/easyXssPayload/burpXssPayload.txt) file under the easyXssPayload directory.

* Added the IDs of security-community hackers from 2018-2020 to the username dictionary, sourced from [Security-Data-Analysis-and-Visualization](https://github.com/404notf0und/Security-Data-Analysis-and-Visualization), with three fields separated: id, blog domain, github ID. Placed at [sec_ID.txt](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/userNameDict/sec_id.txt) under the userNameDict directory. When you get a shell, try these first; if you run your own WAF, just mark all these IDs as blacklist keywords.

* Other optimizations and updates.


20200106:

* Added 100+ new payloads to the XSS dictionary and merged them into this project.

20200104:

* Optimized the parameter dictionary again. Thanks to [key](https://github.com/gh0stkey) for the fixes.

20191219:

* Used the regex `(\W)` to filter out a lot of invalid parameters such as spaces, (){} etc., and allowed `-`. Re-merged and deduplicated the parameter dictionary, all placed in AllParam.txt. Thanks to Naiquan for the feedback.

20191214:

* Recently I've been organizing vulnerabilities across various CMS. I downloaded more than 50 CMS over time and re-collected parameters along the way. The size of parameter.txt grew to 5859 entries. (was 2800+)

20191106:

* Added a Huawei security product default username/password quick-reference table under the password dictionary.

20191026:

* During use I found the parameter dictionary cluttered, so I merged and deduplicated the recently collected parameters and dictionaries from some excellent tools into AllParam.txt — 51219 entries total, recommended.

20191022:

* Added a dictionary from the [Arjun](https://github.com/s0md3v/Arjun) tool under the parameter dictionary. It's much more powerful than the previous script; the dictionary is in the db directory.

20190928:

* Added a wifi password top 2000 dictionary copied from [zhuzhuxia's Github](https://github.com/ring04h) under passwordDict.

20190819:

* Added common vulnerability directories under directoryDicts — recommended to just use all.txt.

* Added a list of weak passwords for common security appliances/routers/middleware/services under passwodDict. That said, I still recommend the RW_Password strong-weak password dictionary, because under the pressure of MLPS (Multi-Level Protection Scheme) compliance many organizations are forced to set complex passwords, and to make them easy to remember these passwords basically all follow patterns — hence "strong-weak passwords", which are really useful.
* Other updates. Part of the dictionaries in this update were collected from [SaiDict](https://github.com/Stardustsky/SaiDict), carefully deduplicated when merging.

20190811:

* Uploaded the dictionary I usually use to brute-force subdomains (extracted and merged from tools like subDomainsBrute and layer, deduplicated, then merged with part of the dictionaries I generated myself). Recommended to use main.txt; the other one is weaker.

20190801:

* Merged a great "strong-weak password" dictionary organized by [r35tart](https://github.com/r35tart/RW_Password) (passwords that look very complex but are actually used by a lot of people).

20190615:

* Merged a [foreign dictionary](https://github.com/emadshanab/WordLists-20111129). The categorization feels a bit messy — I'll reorganize it after my exams.

## content

* [Parameter Fuzz Dictionary](#parameter-fuzz-dictionary)
* [Xss Fuzz Dictionary](#xss-fuzz-dictionary)
* [Username Dictionary](#username-dictionary)
* [Password Dictionary](#password-dictionary)
* [Directory Dictionary](#directory-dictionary)
* [sql-fuzz Dictionary](#sql-fuzz-dictionary)
* [ssrf-fuzz Dictionary](#ssrf-fuzz-dictionary)
* [XXE Dictionary](#xxe-dictionary)
* [ctf Dictionary](#ctf-dictionary)
* [Api Dictionary](#api-dictionary)
* [Router Admin Dictionary](#router-admin-dictionary)
* [File Extension Fuzz](#file-extension-fuzz)
* [js File Dictionary](#js-file-dictionary)
* [Subdomain Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/subdomainDicts)



Recommended tools: [burpsuite](https://portswigger.net/burp/),[sqlmap](https://github.com/sqlmapproject/sqlmap),[xssfork](https://github.com/bsmali4/xssfork),[Wfuzz](https://github.com/xmendez/wfuzz/),[webdirscan](https://github.com/TuuuNya/webdirscan)

If you have any good dictionaries or suggestions, feel free to submit an issue.


## [Parameter Fuzz Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/paramDict)

```
https://github.com/TheKingOfDuck/fuzzDicts/blob/master/paramDict/parameter.txt
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/parameter.jpg)



Collected from common PHP frameworks/CMS such as `ThinkPHP`, `yii2`, `phphub`, `Zblog`, `DiscuzX`, `WordPress`.

Usage tip: e.g. http://127.0.0.1/1.php — treat it as a suspicious file and fuzz the params, selecting GET, POST AND (POST JSON) AND (GET Route) AND cookie param


## [Xss Fuzz Dictionary](https://github.com/TheKingOfDuck/easyXssPayload/blob/master/easyXssPayload.txt)

```
https://github.com/TheKingOfDuck/easyXssPayload/blob/master/easyXssPayload.txt
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/xss.jpg)

Collected from `github`.

## [Username Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/userNameDict)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/userNameDict
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/username.jpg)


## [Password Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/passwordDict)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/passwordDict
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/password.jpg)

## [Directory Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/directoryDicts)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/directoryDicts
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/directory.jpg)


## [SQL Fuzz Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/sqlDict/sql.txt)

```
https://github.com/TheKingOfDuck/fuzzDicts/blob/master/sqlDict/sql.txt
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/sql.jpg)


## [ssrf fuzz Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/ssrfDicts)

```
https://github.com/TheKingOfDuck/fuzzDicts/blob/master/ssrfDicts
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/ssrf.jpg)

Provided by [\xeb\xfe](https://github.com/doge-dog).

## [XXE Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/XXEDicts)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/XXEDicts
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/xxe.jpg)

Collected from Baidu.

## [ctf Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/ctfDict)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/ctfDict
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/ctfDict/ctf-wscan/1.gif)

Collected from [kingkaki](https://github.com/kingkaki/ctf-wscan). When I originally collected it I downloaded the archive directly from Baidu and didn't see the github link, so I didn't mark the source — my apologies.

## [Api Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/apiDict)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/apiDict/api.txt
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/api.jpg)

Zhongkui's collection code is pretty sloppy — I'm such a noob...

## [Router Admin Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/routerDicts)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/routerDicts/pass.txt
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/router.jpg)

## [File Extension Fuzz](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/uploadFileExtDicts)

```
https://github.com/TheKingOfDuck/fuzzDicts/tree/master/uploadFileExtDicts
```

![CoolCat](https://github.com/TheKingOfDuck/fuzzDicts/blob/master/images/fileExt.png)

Collected from https://github.com/c0ny1/upload-fuzz-dic-builder


## [js File Dictionary](https://github.com/TheKingOfDuck/fuzzDicts/tree/master/js)

Collected from: https://github.com/7dog7/bottleneckOsmosis




