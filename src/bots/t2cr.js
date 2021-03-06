const fs = require('fs')
const axios = require('axios')
const { BitlyClient } = require('bitly')
const delay = require('delay')

const { abi: _t2crABI } = require('../contracts/t2cr.json')
const { abi: _badgeABI } = require('../contracts/badge.json')
const { abi: _klerosABI } = require('../contracts/kleros.json')

const T2CR_MONGO_COLLECTION = 'tokens'
const IPFS_URL = 'https://ipfs.kleros.io'

module.exports = async (web3, twitterClient, mongoClient) => {
  console.info('Starting twitter bot')
  const { toChecksumAddress } = web3.utils

  const T2CR_CONTRACT_ADDRESS = toChecksumAddress(
    process.env.T2CR_CONTRACT_ADDRESS
  )
  const ARBITRATOR_CONTRACT_ADDRESS = toChecksumAddress(
    process.env.ARBITRATOR_CONTRACT_ADDRESS
  )

  // Instantiate the contracts.
  const t2crInstance = new web3.eth.Contract(_t2crABI, T2CR_CONTRACT_ADDRESS)
  const klerosInstance = new web3.eth.Contract(
    _klerosABI,
    ARBITRATOR_CONTRACT_ADDRESS
  )

  const badgesInfo = JSON.parse(process.env.BADGES)
  const badgeInstances = badgesInfo.map(
    ({ address }) => new web3.eth.Contract(_badgeABI, address)
  )

  const badgeAddressToTitle = badgesInfo.reduce(
    (prev, curr) => ({
      ...prev,
      [toChecksumAddress(curr.address)]: curr.title,
    }),
    {}
  )
  const badgeAddressToInstance = badgeInstances.reduce(
    (prev, curr) => ({
      ...prev,
      [toChecksumAddress(curr.options.address)]: curr,
    }),
    {}
  )

  const prettyWeiToEth = (weiAmount) => {
    const ethString = web3.utils.fromWei(weiAmount)
    // Only show up to 4 decimal places worth
    const splitAmounts = ethString.split('.')
    return `${splitAmounts[0]}.${
      splitAmounts[1] ? splitAmounts[1].slice(0, 2) : '0'
    }`
  }

  // Connect to the right collection
  await mongoClient.createCollection(T2CR_MONGO_COLLECTION)
  const db = mongoClient.collection(T2CR_MONGO_COLLECTION)

  // Get our starting point
  let lastBlock
  const appState = await db.findOne({ tokenID: '0x0' })
  if (appState) lastBlock = appState.lastBlock
  else {
    // If starting from scratch we can go from current block. No need to tweet history
    lastBlock = await web3.eth.getBlockNumber()
    await db.insertOne({ tokenID: '0x0', lastBlock: lastBlock })
  }

  // Bitly link shortening
  const bitly = new BitlyClient(process.env.BITLY_TOKEN, {})
  while (true) {
    const currentBlock = await web3.eth.getBlockNumber()
    const t2crEvents = await t2crInstance.getPastEvents('allEvents', {
      fromBlock: lastBlock,
      toBlock: currentBlock,
    })

    console.info({
      fromBlock: lastBlock,
      toBlock: currentBlock,
    })

    // Token Events
    console.info('Checking for new t2cr events...')
    for (const t2crEvent of t2crEvents) {
      console.info(' Got T2CR event. Handling.')
      let tweet
      let in_reply_to_status_id
      let tokenID
      let tweetID
      let status

      try {
        if (t2crEvent.event === 'TokenStatusChange') {
          // Get TCR info deposits
          const [
            extraData,
            divisor,
            sharedStakeMultiplier,
            challengerBaseDeposit,
            requesterBaseDeposit,
          ] = await Promise.all([
            t2crInstance.methods.arbitratorExtraData().call(),
            t2crInstance.methods.MULTIPLIER_DIVISOR().call(),
            t2crInstance.methods.sharedStakeMultiplier().call(),
            t2crInstance.methods.challengerBaseDeposit().call(),
            t2crInstance.methods.requesterBaseDeposit().call(),
          ])

          const arbitrationCost = await klerosInstance.methods
            .arbitrationCost(extraData)
            .call()

          const sharedDepositBase = web3.utils
            .toBN(arbitrationCost)
            .mul(web3.utils.toBN(sharedStakeMultiplier))
            .div(web3.utils.toBN(divisor))
          const challengerWinnableDeposit = sharedDepositBase.add(
            web3.utils.toBN(challengerBaseDeposit)
          )
          const requesterWinnableDeposit = sharedDepositBase.add(
            web3.utils.toBN(requesterBaseDeposit)
          )

          tokenID = t2crEvent.returnValues._tokenID
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const shortenedLink = await bitly.shorten(
            `https://tokens.kleros.io/token/${tokenID}`
          )
          // look up to see if this token_id already has a thread
          const tokenThread = await db.findOne({ tokenID })
          if (tokenThread) in_reply_to_status_id = await tokenThread.lastTweetID
          if (String(t2crEvent.returnValues._status) === '0') {
            const tokenInfo = await t2crInstance.methods
              .getTokenInfo(tokenID)
              .call()

            status = `#${token.name.replace(/ /g, '')} $${
              token.ticker
            } has been ${
              Number(tokenInfo.numberOfRequests) > 1 ? 'removed' : 'rejected'
            }. ${
              t2crEvent.returnValues._disputed
                ? `The challenger has won the deposit of ${prettyWeiToEth(
                    requesterWinnableDeposit
                  )} ETH`
                : ''
            }`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          } else if (String(t2crEvent.returnValues._status) === '1') {
            status = `#${token.name.replace(/ /g, '')} $${
              token.ticker
            } has been accepted into the list. ${
              t2crEvent.returnValues._disputed
                ? `The submitter has taken the challengers deposit of ${prettyWeiToEth(
                    challengerWinnableDeposit
                  )} ETH`
                : ''
            }`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          } else if (
            t2crEvent.returnValues._disputed &&
            !t2crEvent.returnValues._appealed
          ) {
            status = `Token Challenged! #${token.name.replace(/ /g, '')} $${
              token.ticker
            } is headed to court ${shortenedLink.url}`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          } else if (
            t2crEvent.returnValues._disputed &&
            t2crEvent.returnValues._appealed
          ) {
            status = `The ruling on #${token.name.replace(/ /g, '')} $${
              token.ticker
            } has been appealed ${shortenedLink.url}`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          } else if (String(t2crEvent.returnValues._status) === '2') {
            // Have to hack it to get the file in the right type. RIP
            const image = await axios.get(
              (token.symbolMultihash[0] === '/'
                ? `${IPFS_URL}`
                : `${process.env.FILE_BASE_URL}/`) + token.symbolMultihash,
              { responseType: 'arraybuffer' }
            )
            if (!fs.existsSync('./tmp')) fs.mkdirSync('./tmp')
            const filePath = `./tmp/image.${
              image.headers['content-type'].split('/')[1]
            }`
            fs.writeFileSync(filePath, image.data)
            const file = fs.readFileSync(filePath, { encoding: 'base64' })
            const media = await twitterClient.post('media/upload', {
              media_data: file,
            })
            fs.unlinkSync(filePath)

            const shortenedTokenLink = await bitly.shorten(
              `https://etherscan.io/token/${token.addr}`
            )

            status = `#${token.name.replace(/ /g, '')} $${
              token.ticker
            } submitted. Verify the it for a chance to win ${prettyWeiToEth(
              requesterWinnableDeposit
            )} #ETH
                    \nToken Address: ${shortenedTokenLink.url}
                    \nListing: ${shortenedLink.url}`

            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
              media_ids: [media.data.media_id_string],
            })

            tweetID = tweet.data.id_str
          } else {
            status = `Someone requested to remove #${token.name.replace(
              / /g,
              ''
            )} $${token.ticker} with a deposit of ${prettyWeiToEth(
              requesterWinnableDeposit
            )} ETH. Verify it for a chance to win the deposit
                \nSee the listing here: ${shortenedLink.url}`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          }
        } else if (t2crEvent.event === 'Evidence') {
          const tx = await web3.eth.getTransaction(t2crEvent.transactionHash)
          tokenID = `0x${tx.input.slice(10, 74)}`
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({ tokenID })
          if (tokenThread) in_reply_to_status_id = await tokenThread.lastTweetID

          const evidenceURI =
            t2crEvent.returnValues._evidence[0] === '/'
              ? `${IPFS_URL}${t2crEvent.returnValues._evidence}`
              : t2crEvent.returnValues._evidence
          const evidence = await axios.get(evidenceURI)
          const evidenceJSON = evidence.data

          let shortenedLink

          if (evidenceJSON.fileURI) {
            const linkURI =
              evidenceJSON.fileURI[0] === '/'
                ? `${IPFS_URL}${evidenceJSON.fileURI}`
                : evidenceJSON.fileURI
            shortenedLink = await bitly.shorten(linkURI)
          }
          const evidenceTitle = evidenceJSON.title || evidenceJSON.name || ''
          evidenceJSON.name = evidenceTitle
          const evidenceDescription = evidenceJSON.description || ''

          if (evidenceTitle.length + evidenceDescription.length > 130) {
            if (evidenceTitle.length > 20)
              evidenceJSON.name = `${evidenceTitle.slice(0, 17)}...`
            if (evidenceDescription.length > 110)
              evidenceJSON.description = `${evidenceDescription.slice(
                0,
                107
              )}...`
          }

          const shortenedTokenLink = await bitly.shorten(
            `https://tokens.kleros.io/token/${tokenID}`
          )

          status = `New Evidence for #${token.name.replace(/ /g, '')}: ${
            evidenceJSON.name || ''
          }
          ${evidenceJSON.description ? `\n${evidenceJSON.description}` : ''}
          \n${shortenedLink ? `\nLink: ${shortenedLink.url}` : ''}
          \n\nSee Full Evidence: ${shortenedTokenLink.url}`

          tweet = await twitterClient.post('statuses/update', {
            status,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true,
          })
          tweetID = tweet.data.id_str
        }
      } catch (err) {
        // Duplicate tweet. just move on
        console.error(err)
        console.error('Tweet content:', status)
        continue
      }

      // Update thread id
      if (tweetID)
        await db.findOneAndUpdate(
          { tokenID },
          { $set: { lastTweetID: tweetID } },
          { upsert: true }
        )
    }

    console.info('Checking for new kleros events...')
    const klerosEvents = await klerosInstance.getPastEvents('AppealPossible', {
      fromBlock: lastBlock,
      toBlock: currentBlock,
    })

    // RULINGS
    for (const klerosEvent of klerosEvents) {
      console.info(' Got kleros event. Handling.')
      let tweetID
      let in_reply_to_status_id
      let tokenID
      let status
      try {
        // Detect if it is a t2cr or a badge event or neither.
        if (
          toChecksumAddress(klerosEvent.returnValues._arbitrable) ===
          T2CR_CONTRACT_ADDRESS
        ) {
          // This event is related to the T2CR;
          tokenID = await t2crInstance.methods
            .arbitratorDisputeIDToTokenID(
              ARBITRATOR_CONTRACT_ADDRESS,
              klerosEvent.returnValues._disputeID
            )
            .call()
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({ tokenID })
          if (tokenThread) in_reply_to_status_id = await tokenThread.lastTweetID

          const currentRuling = await klerosInstance.methods
            .currentRuling(klerosEvent.returnValues._disputeID)
            .call()
          if (String(currentRuling) === '0') continue

          const extraData = await t2crInstance.methods
            .arbitratorExtraData()
            .call()
          const appealCost = await klerosInstance.methods
            .appealCost(klerosEvent.returnValues._disputeID, extraData)
            .call()
          const winnerStakeMultiplier = await t2crInstance.methods
            .winnerStakeMultiplier()
            .call()

          const divisor = await t2crInstance.methods.MULTIPLIER_DIVISOR().call()

          const maxFee = web3.utils
            .toBN(appealCost)
            .mul(web3.utils.toBN(winnerStakeMultiplier))
            .div(web3.utils.toBN(divisor))
            .toString()

          const shortenedLink = await bitly.shorten(
            `https://tokens.kleros.io/token/${tokenID}`
          )

          status = `Jurors have ruled ${
            String(currentRuling) === '1' ? 'to accept' : 'against'
          } the request #${token.name.replace(
            / /g,
            ''
          )}. Think they are wrong? Fund an appeal for the chance to win up to ${prettyWeiToEth(
            maxFee
          )} ETH.
          \nSee the listing here: ${shortenedLink.url}`
          const tweet = await twitterClient.post('statuses/update', {
            status,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true,
          })
          tweetID = tweet.data.id_str
        }

        const badgeContractInstance =
          badgeAddressToInstance[
            toChecksumAddress(klerosEvent.returnValues._arbitrable)
          ]
        if (badgeContractInstance) {
          // This is a badge event.
          const tokenAddress = await badgeContractInstance.methods
            .arbitratorDisputeIDToAddress(
              ARBITRATOR_CONTRACT_ADDRESS,
              klerosEvent.returnValues._disputeID
            )
            .call()

          const tokenQuery = await t2crInstance.methods
            .queryTokens(
              '0x0000000000000000000000000000000000000000000000000000000000000000',
              1,
              [false, true, false, false, false, false, false, false],
              true,
              tokenAddress
            )
            .call()
          tokenID = tokenQuery.values[0]
          const token = await t2crInstance.methods.tokens(tokenID).call()

          const tokenThread = await db.findOne({ tokenID })
          if (tokenThread) in_reply_to_status_id = await tokenThread.lastTweetID

          const currentRuling = await klerosInstance.methods
            .currentRuling(klerosEvent.returnValues._disputeID)
            .call()
          if (String(currentRuling) === '0') continue

          const extraData = await badgeContractInstance.methods
            .arbitratorExtraData()
            .call()
          const appealCost = await klerosInstance.methods
            .appealCost(klerosEvent.returnValues._disputeID, extraData)
            .call()
          const winnerStakeMultiplier = await badgeContractInstance.methods
            .winnerStakeMultiplier()
            .call()
          const divisor = await badgeContractInstance.methods
            .MULTIPLIER_DIVISOR()
            .call()

          const maxFee = web3.utils
            .toBN(appealCost)
            .mul(web3.utils.toBN(winnerStakeMultiplier))
            .div(web3.utils.toBN(divisor))
            .toString()

          const shortenedLink = await bitly.shorten(
            `https://tokens.kleros.io/badge/${toChecksumAddress(
              badgeContractInstance.options.address
            )}/${toChecksumAddress(tokenAddress)}`
          )
          const badgeTitle =
            badgeAddressToTitle[
              toChecksumAddress(badgeContractInstance.options.address)
            ]

          status = `Jurors have ruled ${
            String(currentRuling) === '1' ? 'for' : 'against'
          } the request on #${token.name.replace(
            / /g,
            ''
          )} the ${badgeTitle} Badge. Think they are wrong? Fund an appeal for the chance to win up to ${prettyWeiToEth(
            maxFee
          )} ETH.
          \nSee the listing here: ${shortenedLink.url}`
          const tweet = await twitterClient.post('statuses/update', {
            status,
            in_reply_to_status_id,
            auto_populate_reply_metadata: true,
          })
          tweetID = tweet.data.id_str
        }
      } catch (err) {
        // Duplicate tweet. just move on
        console.error(err)
        console.error('Tweet content:', status)
        continue
      }

      // Update thread id
      if (tweetID)
        await db.findOneAndUpdate(
          { tokenID },
          { $set: { lastTweetID: tweetID } },
          { upsert: true }
        )
    }

    const badgesEvents = await Promise.all(
      badgeInstances.map((badgeInstance) =>
        badgeInstance.getPastEvents('allEvents', {
          fromBlock: lastBlock,
          toBlock: currentBlock,
        })
      )
    )

    console.info('Checking badges events...')
    for (const badgeEvents of badgesEvents)
      for (const badgeEvent of badgeEvents) {
        console.info('Got badge event. Handling')
        let tweet
        let in_reply_to_status_id
        let tokenID
        let tweetID
        const badgeContractInstance =
          badgeAddressToInstance[toChecksumAddress(badgeEvent.address)]
        const badgeTitle =
          badgeAddressToTitle[toChecksumAddress(badgeEvent.address)]
        let status

        try {
          if (badgeEvent.event === 'AddressStatusChange') {
            // Get base deposits
            const [
              extraData,
              divisor,
              sharedStakeMultiplier,
              challengerBaseDeposit,
              requesterBaseDeposit,
            ] = await Promise.all([
              badgeContractInstance.methods.arbitratorExtraData().call(),
              badgeContractInstance.methods.MULTIPLIER_DIVISOR().call(),
              badgeContractInstance.methods.sharedStakeMultiplier().call(),
              badgeContractInstance.methods.challengerBaseDeposit().call(),
              badgeContractInstance.methods.requesterBaseDeposit().call(),
            ])

            const arbitrationCost = await klerosInstance.methods
              .arbitrationCost(extraData)
              .call()

            const sharedDepositBase = web3.utils
              .toBN(arbitrationCost)
              .mul(web3.utils.toBN(sharedStakeMultiplier))
              .div(web3.utils.toBN(divisor))
            const challengerWinnableDeposit = sharedDepositBase.add(
              web3.utils.toBN(challengerBaseDeposit)
            )
            const requesterWinnableDeposit = sharedDepositBase.add(
              web3.utils.toBN(requesterBaseDeposit)
            )

            const tokenAddress = badgeEvent.returnValues._badgeABI

            const tokenQuery = await t2crInstance.methods
              .queryTokens(
                '0x0000000000000000000000000000000000000000000000000000000000000000',
                1,
                [false, true, false, false, false, false, false, false],
                true,
                tokenAddress
              )
              .call()
            tokenID = tokenQuery.values[0]
            const token = await t2crInstance.methods.tokens(tokenID).call()

            const shortenedLink = await bitly.shorten(
              `https://tokens.kleros.io/badge/${toChecksumAddress(
                badgeEvent.address
              )}/${toChecksumAddress(tokenAddress)}`
            )

            // Check if this token_id already has a thread
            const tokenThread = await db.findOne({ tokenID })
            if (tokenThread)
              in_reply_to_status_id = await tokenThread.lastTweetID
            if (String(badgeEvent.returnValues._status) === '0') {
              status = `#${token.name.replace(
                / /g,
                ''
              )} has been denied the ${badgeTitle} Badge. ${
                badgeEvent.returnValues._disputed
                  ? `The challenger has won the deposit of ${prettyWeiToEth(
                      requesterWinnableDeposit
                    )} ETH`
                  : ''
              }`

              tweet = await twitterClient.post('statuses/update', {
                status,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true,
              })
              tweetID = tweet.data.id_str
            } else if (String(badgeEvent.returnValues._status) === '1') {
              if (in_reply_to_status_id) {
                status = `#${token.name.replace(
                  / /g,
                  ''
                )} has been awarded the ${badgeTitle} Badge. ${
                  badgeEvent.returnValues._disputed
                    ? `The submitter has taken the challengers deposit of ${prettyWeiToEth(
                        challengerWinnableDeposit
                      )} ETH`
                    : ''
                }`

                tweet = await twitterClient.post('statuses/update', {
                  status,
                  in_reply_to_status_id,
                  auto_populate_reply_metadata: true,
                })
              }

              tweetID = tweet.data.id_str
            } else if (
              badgeEvent.returnValues._disputed &&
              !badgeEvent.returnValues._appealed
            ) {
              status = `${badgeTitle} Badge Challenged! #${token.name.replace(
                / /g,
                ''
              )} is headed to court`

              tweet = await twitterClient.post('statuses/update', {
                status,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true,
              })
              tweetID = tweet.data.id_str
            } else if (
              badgeEvent.returnValues._disputed &&
              badgeEvent.returnValues._appealed
            ) {
              status = `The ruling on the ${badgeTitle} Badge for #${token.name.replace(
                / /g,
                ''
              )} has been appealed.`

              tweet = await twitterClient.post('statuses/update', {
                status,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true,
              })
              tweetID = tweet.data.id_str
            } else if (String(badgeEvent.returnValues._status) === '2') {
              const file = fs.readFileSync(
                `./assets/${toChecksumAddress(badgeEvent.options.address)}.jpg`,
                {
                  encoding: 'base64',
                }
              )
              const media = await twitterClient.post('media/upload', {
                media_data: file,
              })

              status = `#${token.name.replace(
                / /g,
                ''
              )} has requested the ${badgeTitle} Badge. Verify it meets the criteria for a chance to win ${prettyWeiToEth(
                requesterWinnableDeposit
              )} ETH. \n\nSee the listing here: ${shortenedLink.url}`

              tweet = await twitterClient.post('statuses/update', {
                status,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true,
                media_ids: [media.data.media_id_string],
              })
              tweetID = tweet.data.id_str
            } else {
              status = `Someone requested to remove an ${badgeTitle} Badge from #${token.name.replace(
                / /g,
                ''
              )} with a deposit of ${prettyWeiToEth(
                requesterWinnableDeposit
              )} ETH. If you challenge the removal and win, you will take the deposit. \n\nSee the listing here: ${
                shortenedLink.url
              }`

              tweet = await twitterClient.post('statuses/update', {
                status,
                in_reply_to_status_id,
                auto_populate_reply_metadata: true,
              })
              tweetID = tweet.data.id_str
            }
          } else if (badgeEvent.event === 'Evidence') {
            const tx = await web3.eth.getTransaction(badgeEvent.transactionHash)
            const tokenAddress = `0x${tx.input.slice(34, 74)}`

            const tokenQuery = await t2crInstance.methods
              .queryTokens(
                '0x0000000000000000000000000000000000000000000000000000000000000000',
                1,
                [false, true, false, false, false, false, false, false],
                true,
                tokenAddress
              )
              .call()
            tokenID = tokenQuery.values[0]
            const token = await t2crInstance.methods.tokens(tokenID).call()

            const tokenThread = await db.findOne({ tokenID })
            if (tokenThread)
              in_reply_to_status_id = await tokenThread.lastTweetID

            const evidenceURI =
              badgeEvent.returnValues._evidence[0] === '/'
                ? `${IPFS_URL}${badgeEvent.returnValues._evidence}`
                : badgeEvent.returnValues._evidence
            const evidence = await axios.get(evidenceURI)
            const evidenceJSON = evidence.data

            let shortenedLink

            if (evidenceJSON.fileURI) {
              const linkURI =
                evidenceJSON.fileURI[0] === '/'
                  ? `${IPFS_URL}${evidenceJSON.fileURI}`
                  : evidenceJSON.fileURI
              shortenedLink = await bitly.shorten(linkURI)
            }
            const evidenceTitle = evidenceJSON.title || evidenceJSON.name || ''
            evidenceJSON.name = evidenceTitle
            const evidenceDescription = evidenceJSON.description || ''

            if (evidenceTitle.length + evidenceDescription.length > 130) {
              if (evidenceTitle.length > 20)
                evidenceJSON.name = `${evidenceTitle.slice(0, 17)}...`
              if (evidenceDescription.length > 110)
                evidenceJSON.description = `${evidenceDescription.slice(
                  0,
                  107
                )}...`
            }

            const shortenedTokenLink = await bitly.shorten(
              `https://tokens.kleros.io/badge/${toChecksumAddress(
                badgeContractInstance.options.address
              )}/${toChecksumAddress(tokenAddress)}`
            )

            status = `New Evidence for #${token.name.replace(
              / /g,
              ''
            )}'s ${badgeTitle} Badge: ${evidenceJSON.name}
            ${evidenceJSON.description ? `\n${evidenceJSON.description}` : ''}
            \n${shortenedLink ? `\nLink: ${shortenedLink.url}` : ''}
            \n\nSee Full Evidence: ${shortenedTokenLink.url}`
            tweet = await twitterClient.post('statuses/update', {
              status,
              in_reply_to_status_id,
              auto_populate_reply_metadata: true,
            })
            tweetID = tweet.data.id_str
          }
        } catch (err) {
          // Duplicate tweet. just move on
          console.error(err)
          console.error('Tweet content:', status)
          continue
        }
        // Update thread id
        if (tweetID)
          await db.findOneAndUpdate(
            { tokenID },
            { $set: { lastTweetID: tweetID } },
            { upsert: true }
          )
      }

    await db.findOneAndUpdate(
      { tokenID: '0x0' },
      { $set: { lastBlock: currentBlock } },
      { upsert: true }
    )
    lastBlock = currentBlock + 1

    console.info('Done... Waiting for new check.')
    await delay(1000 * 60 * 5) // Run every 5 minutes.
  }
}
