"""Fixed authenticated storage request. No path resolution or executable arguments."""
import json
import os
import runpy
import sys
from pathlib import Path

IMAGE = Path('/opt/osv-q2b/b1ct'); sys.path.insert(0, str(IMAGE))
import auth


def run(role, operation, argument):
    auth.need(role in auth.ROLES and os.getresuid() == (auth.ROLES[role][0],) * 3 and os.getresgid() == (auth.ROLES[role][1],) * 3 and not os.getgroups(), 'principal')
    client = runpy.run_path(str(IMAGE / 'client_probe.py'))
    private, public, context = client['material'](role); observed = []; sent = []
    with client['channel'](role) as connection:
        session = auth.client_auth(connection, context, role, private, public, observed, sent=sent)
        request = auth.sign({**auth.request(session, 1, operation, private, role)['body'], 'argument': argument}, role, private)
        raw = auth.send(connection, request, session['deadline'])
        response, _ = auth.receive(connection, session['deadline'], (context['providerPid'], 1101, 1201), observed)
        body = auth.verify(response, 'provider', public)
        auth.need(set(body) == {'kind', 'sessionId', 'sequence', 'requestDigest', 'operation', 'outcome', 'reason', 'result', 'backendEligible', 'originalReadsSkipped'} and
                  body['kind'] == 'storage-response' and body['sessionId'] == session['sessionId'] and type(body['sequence']) is int and body['sequence'] == 1 and
                  body['requestDigest'] == auth.digest(raw) and body['operation'] == operation and body['outcome'] in ('accepted', 'rejected') and
                  body['backendEligible'] is False and type(body['originalReadsSkipped']) is int and body['originalReadsSkipped'] == 0, 'storage-response-binding')
        return {'response': response, 'request': request, 'proof': session['proof'], 'challenge': session['challenge'],
                'providerCredentials': observed, 'clientProofFrames': len(sent), 'providerBoot': context['providerBoot']}


if __name__ == '__main__':
    print(json.dumps(run(sys.argv[1], sys.argv[2], json.loads(sys.argv[3])), sort_keys=True))
