'use strict'
/* eslint-disable class-methods-use-this */

const net = require('net')

const IncomingConnection = require('../src/cluster/incoming-connection')
const OutgoingConnection = require('../src/cluster/outgoing-connection')
const utils = require('../src/utils/utils')

const STATE = {
  INIT: 0,
  DISCOVERY: 1,
  BROADCAST: 2,
  LISTEN: 3,
  CLOSED: 4
}

const STATE_LOOKUP = utils.reverseMap(STATE)

class ClusterNode {
  constructor (config) {
    this._config = config
    this._seedNodes = config.seedNodes
    this._serverName = config.serverName
    this._url = `${config.host}:${config.port}`

    this._tcpServer = net.createServer(this._onIncomingConnection.bind(this))
    this._tcpServer.listen(config.port, config.host, this._onReady.bind(this))

    this._connections = new Set()
    // serverName -> connection
    this._knownPeers = new Map()
    this._knownUrls = new Set()

    this._state = STATE.INIT
    this._electionNumber = Math.random()
    this._leader = null
    this._decideLeader()
  }

  _stateTransition (nextState) {
    {
      const current = STATE_LOOKUP[this._state]
      const next = STATE_LOOKUP[nextState]
      console.log(`<><> node state transition ${current} -> ${next} <><>`)
      console.log('<><> peers', this._knownUrls, '<><>', this._leader, '<><>')
    }
    this._state = nextState
  }

  _onReady () {
    console.log('server ready')
    for (let i = 0; i < this._seedNodes.length; i++) {
      this._probeHost(this._seedNodes[i])
    }
  }

  _probeHost (nodeUrl) {
    if (this._url === nodeUrl || this._knownUrls.has(nodeUrl)) {
      return
    }
    const parts = nodeUrl.split(':')
    if (parts.length !== 2) {
      throw new Error(`Invalid node url ${nodeUrl}, must have a host and port e.g. '0.0.0.0:9089'`)
    }
    const connection = new OutgoingConnection(nodeUrl, this._config)
    connection.on('error', this._onConnectionError.bind(this, connection))
    connection.on('connect', () => {
      this._addConnection(connection)
      connection.sendWho({
        id: this._serverName,
        url: this._url
      })
    })

    connection.on('iam', (message) => {
      if (!message.id || !message.peers || message.electionNumber === undefined) {
        console.error('malformed iam message', message)
        // TODO: send error
        return
      }
      connection.setRemoteDetails(message.id, message.electionNumber)
      if (this._knownPeers.has(connection.remoteName)) {
        // this peer was already known to us, but responded to our identification message
        // TODO: warn, reject with reason
        this._removeConnection(connection)
        console.error('received IAM from an outbound connection to a known peer')
      } else {
        this._addPeer(connection)
        for (const url of message.peers) {
          this._probeHost(url)
        }
      }
      this._checkReady()
    })
  }

  _checkReady () {
    for (const connection of this._connections) {
      if (!connection.isIdentified()) {
        return
      }
    }
    this._stateTransition(STATE.BROADCAST)
    this._startBroadcast()
  }

  _startBroadcast () {
    for (const connection of this._connections) {
      console.log('send known to', connection.remoteUrl)
      connection.sendKnown({
        peers: this._getPeers()
      })
    }
    this._stateTransition(STATE.LISTEN)
  }

  _addPeer (connection) {
    if (!connection.remoteName || !connection.remoteUrl) {
      throw new Error('tried to add uninitialized peer')
    }
    this._knownPeers.set(connection.remoteName, connection)
    this._knownUrls.add(connection.remoteUrl)
    this._decideLeader()
  }

  _removePeer (connection) {
    if (!connection.remoteName || !connection.remoteUrl) {
      throw new Error('tried to remove uninitialized peer')
    }
    this._knownPeers.delete(connection.remoteName)
    this._knownUrls.delete(connection.remoteUrl)
    this._decideLeader()
  }

  _decideLeader () {
    let leader = this._serverName
    let leaderNumber = this._electionNumber
    for (const connection of this._knownPeers.values()) {
      if (connection.electionNumber > leaderNumber) {
        leader = connection.remoteName
        leaderNumber = connection.electionNumber
      }
    }
    this._leader = leader
  }

  _onIncomingConnection (socket) {
    const connection = new IncomingConnection(socket, this._config)
    connection.on('error', this._onConnectionError.bind(this, connection))
    connection.on('who', (message) => {
      if (!message.id || !message.url || !message.electionNumber) {
        console.error('malformed who message', message)
        // send error
        return
      }
      connection.setRemoteDetails(message.id, message.electionNumber, message.url)
      if (this._knownPeers.has(connection.remoteName)) {
        // I'm already connected to this peer, probably through an outbound connection, reject
        // TODO: reject
        console.error('received inbound connection from peer that was already known')
        return
      }

      connection.sendIAm({
        id: this._serverName,
        peers: this._getPeers(),
        electionNumber: this._electionNumber
      })

      this._addPeer(connection)
    })
    connection.on('known', (message) => {
      if (!message.peers || message.peers.constructor !== Array) {
        console.error('malformed known message', message)
        // send error
        return
      }

      for (const url of message.peers) {
        this._probeHost(url)
      }

      this._checkReady()
    })
    this._addConnection(connection)
    console.log('new incoming connection from socket', connection.remoteUrl)
  }

  _getPeers () {
    return Array.from(this._knownUrls)
  }

  _addConnection (connection) {
    connection.once('close', this._removeConnection.bind(this, connection))
    connection.on('message', this._onMessage.bind(this, connection))

    this._connections.add(connection)
  }

  _removeConnection (connection) {
    this._connections.delete(connection)
    if (this._knownPeers.has(connection.serverName)) {
      this._removePeer(connection)
    }
  }

  _onConnectionError (connection, error) {
    console.error('connection error', error)
  }

  _onMessage (connection, topic, message) {
    console.log('onmessage', topic, message)
  }

  close () {
    this._tcpServer.close(() => {})
    this._connections.forEach(connection => connection.close())
  }
}

module.exports = ClusterNode

if (!module.parent) {
  console.log('command line mode')
  const config = {
    host: process.argv[2],
    port: process.argv[3],
    seedNodes: process.argv.slice(4),
    maxReconnectAttempts: 4,
    reconnectInterval: 1500,
    serverName: Math.random()
  }
  console.log(config)
  const node = new ClusterNode(config)
  process.on('SIGINT', () => node.close())
}
